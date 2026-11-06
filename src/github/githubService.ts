import * as vscode from 'vscode';
import { GitRepository } from '../git/repository';
import { RepoManager } from '../model/repoManager';
import { CheckState, GitHubClient, getSession, parseRemote, PullRequest, RemoteInfo } from './api';

const TTL_MS = 60_000;

interface RepoData {
  remote: RemoteInfo | undefined | null; // null = looked up, not GitHub
  defaultBranch?: string;
  pulls: Map<string, PullRequest>; // by head branch
  checks: Map<string, CheckState>; // by head sha
  fetchedAt: number;
  loading?: Promise<void>;
}

export type GitHubState = 'none' | 'signedOut' | 'ready';

/** GitHub Enterprise hosts: VS Code's own `github-enterprise.uri` plus our setting. */
function enterpriseHosts(): string[] {
  const hosts: string[] = [];
  const ghe = vscode.workspace.getConfiguration('github-enterprise').get<string>('uri');
  if (ghe) {
    try {
      hosts.push(new URL(ghe).hostname);
    } catch {
      hosts.push(ghe);
    }
  }
  hosts.push(...vscode.workspace.getConfiguration('sourcestudio.github').get<string[]>('enterpriseHosts', []));
  return hosts;
}

/**
 * Keeps PR + check status for every GitHub-backed repo. Data is pulled when a repo's
 * status changes (debounced, cached for a minute) so the Branches view can decorate
 * branches without hammering the API.
 */
export class GitHubService implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<GitRepository>();
  readonly onDidChange = this._onDidChange.event;

  private readonly data = new Map<string, RepoData>();
  private readonly sessions = new Map<string, vscode.AuthenticationSession | undefined>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly repos: RepoManager) {
    this.disposables.push(
      repos.onDidChangeStatus((r) => this.schedule(r)),
      repos.onDidChangeActive((r) => {
        if (r) this.schedule(r, 0);
        void this.updateContext();
      }),
      vscode.authentication.onDidChangeSessions(() => {
        this.sessions.clear();
        for (const r of repos.repositories) this.schedule(r, 0, true);
      }),
    );
  }

  private get enabled(): boolean {
    return vscode.workspace.getConfiguration('sourcestudio.github').get<boolean>('enabled', true);
  }

  // ---------------------------------------------------------------- queries

  remote(repo: GitRepository): RemoteInfo | undefined {
    return this.data.get(repo.root)?.remote ?? undefined;
  }

  /** Resolves (and caches) the remote, returning undefined when it isn't GitHub. */
  async ensureRemote(repo: GitRepository): Promise<RemoteInfo | undefined> {
    return (await this.ensure(repo))?.remote ?? undefined;
  }

  pullFor(repo: GitRepository, branch: string): PullRequest | undefined {
    return this.data.get(repo.root)?.pulls.get(branch);
  }

  checksFor(repo: GitRepository, sha: string): CheckState | undefined {
    const d = this.data.get(repo.root);
    if (!d) return undefined;
    for (const [k, v] of d.checks) if (sha.startsWith(k) || k.startsWith(sha)) return v;
    return undefined;
  }

  async defaultBranch(repo: GitRepository): Promise<string> {
    const d = await this.ensure(repo);
    if (d?.defaultBranch) return d.defaultBranch;
    const client = await this.client(repo);
    if (client && d?.remote) {
      try {
        d.defaultBranch = await client.defaultBranch(d.remote.owner, d.remote.repo);
        return d.defaultBranch;
      } catch {
        /* fall through */
      }
    }
    // No API: guess from the remote HEAD symref, then common names.
    const head = repo.branches.find((b) => b.remote && /\/HEAD$/.test(b.fullRef));
    if (head) return head.name.split('/').slice(1).join('/');
    return repo.branches.some((b) => b.name === 'main') ? 'main' : 'master';
  }

  async state(repo: GitRepository): Promise<GitHubState> {
    const d = await this.ensure(repo);
    if (!d?.remote || !this.enabled) return 'none';
    return (await this.session(d.remote, false)) ? 'ready' : 'signedOut';
  }

  /** Interactive sign-in (consent dialog or browser flow), then refresh. */
  async signIn(repo: GitRepository): Promise<boolean> {
    const d = await this.ensure(repo);
    if (!d?.remote) {
      void vscode.window.showInformationMessage(`${repo.name} has no GitHub remote.`);
      return false;
    }
    const s = await this.session(d.remote, true);
    if (s) {
      this.schedule(repo, 0, true);
      await this.updateContext();
    }
    return !!s;
  }

  // ---------------------------------------------------------------- loading

  private async ensure(repo: GitRepository): Promise<RepoData | undefined> {
    let d = this.data.get(repo.root);
    if (!d) {
      d = { remote: undefined, pulls: new Map(), checks: new Map(), fetchedAt: 0 };
      this.data.set(repo.root, d);
    }
    if (d.remote === undefined) {
      const name = vscode.workspace.getConfiguration('sourcestudio.github').get<string>('remote', 'origin');
      const url = await repo.remoteUrl(name);
      d.remote = url ? (parseRemote(url, enterpriseHosts()) ?? null) : null;
    }
    return d;
  }

  private async session(remote: RemoteInfo, prompt: boolean): Promise<vscode.AuthenticationSession | undefined> {
    const cached = this.sessions.get(remote.authProvider);
    if (cached || (!prompt && this.sessions.has(remote.authProvider))) return cached;
    const s = await getSession(remote.authProvider, prompt);
    this.sessions.set(remote.authProvider, s);
    return s;
  }

  private async client(repo: GitRepository): Promise<GitHubClient | undefined> {
    const d = await this.ensure(repo);
    if (!d?.remote || !this.enabled) return undefined;
    const s = await this.session(d.remote, false);
    return s ? new GitHubClient(s.accessToken, d.remote.apiUrl) : undefined;
  }

  private schedule(repo: GitRepository, delay = 1500, force = false): void {
    if (!this.enabled) return;
    const t = this.timers.get(repo.root);
    if (t) clearTimeout(t);
    this.timers.set(
      repo.root,
      setTimeout(() => void this.load(repo, force), delay),
    );
  }

  private async load(repo: GitRepository, force: boolean): Promise<void> {
    const d = await this.ensure(repo);
    if (!d?.remote) return;
    if (d.loading) return d.loading;
    if (!force && Date.now() - d.fetchedAt < TTL_MS) return;
    d.loading = (async () => {
      try {
        const client = await this.client(repo);
        if (!client) return;
        const { owner, repo: name } = d.remote!;
        const pulls = await client.openPulls(owner, name);
        d.pulls = new Map(pulls.filter((p) => !p.fromFork).map((p) => [p.headRef, p]));
        // Checks for PR heads + the current branch, in parallel, failures ignored.
        const shas = new Set(pulls.map((p) => p.headSha));
        const current = repo.currentBranch;
        if (current) shas.add(current.sha);
        const results = await Promise.all([...shas].map(async (sha) => [sha, await client.checks(owner, name, sha).catch(() => 'none' as CheckState)] as const));
        d.checks = new Map(results);
        d.fetchedAt = Date.now();
        this._onDidChange.fire(repo);
      } catch (e) {
        console.error('[sourcestudio] GitHub fetch failed', e);
      } finally {
        d.loading = undefined;
        await this.updateContext();
      }
    })();
    return d.loading;
  }

  private async updateContext(): Promise<void> {
    const active = this.repos.active;
    const state = active ? await this.state(active) : 'none';
    await vscode.commands.executeCommand('setContext', 'sourcestudio.github', state);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.disposables.forEach((d) => d.dispose());
    this._onDidChange.dispose();
  }
}
