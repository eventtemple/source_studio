import * as vscode from 'vscode';

export interface RemoteInfo {
  host: string;
  owner: string;
  repo: string;
  /** `https://github.com/owner/repo` */
  webUrl: string;
  /** `https://api.github.com` or `https://ghes.example.com/api/v3` */
  apiUrl: string;
  /** VS Code auth provider: 'github' for github.com, 'github-enterprise' for GHES. */
  authProvider: string;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  author: string;
  /** True when the head branch lives in a fork. */
  fromFork: boolean;
}

export type CheckState = 'success' | 'failure' | 'pending' | 'none';

export const SCOPES = ['repo'];

/**
 * Parses `git@github.com:owner/repo.git`, `https://github.com/owner/repo(.git)`, `ssh://git@host/owner/repo`.
 * Hosts other than github.com are only accepted when listed in `enterpriseHosts`.
 */
export function parseRemote(url: string, enterpriseHosts: string[] = []): RemoteInfo | undefined {
  const m =
    /^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim()) ??
    /^https?:\/\/(?:[^@/]+@)?([\w.-]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) return undefined;
  const [, host, owner, repo] = m;
  const isDotCom = host.toLowerCase() === 'github.com';
  if (!isDotCom && !enterpriseHosts.some((h) => h.toLowerCase() === host.toLowerCase())) return undefined;
  return {
    host,
    owner,
    repo,
    webUrl: `https://${host}/${owner}/${repo}`,
    apiUrl: isDotCom ? 'https://api.github.com' : `https://${host}/api/v3`,
    authProvider: isDotCom ? 'github' : 'github-enterprise',
  };
}

export class GitHubClient {
  constructor(private readonly token: string, private readonly apiUrl: string) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'source-studio-vscode',
      },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
    return (await res.json()) as T;
  }

  async defaultBranch(owner: string, repo: string): Promise<string> {
    const r = await this.get<{ default_branch: string }>(`/repos/${owner}/${repo}`);
    return r.default_branch;
  }

  async openPulls(owner: string, repo: string): Promise<PullRequest[]> {
    type Raw = {
      number: number;
      title: string;
      html_url: string;
      draft: boolean;
      user: { login: string };
      head: { ref: string; sha: string; repo: { full_name: string } | null };
      base: { ref: string };
    };
    const raw = await this.get<Raw[]>(`/repos/${owner}/${repo}/pulls?state=open&per_page=100`);
    return raw.map((p) => ({
      number: p.number,
      title: p.title,
      url: p.html_url,
      draft: p.draft,
      headRef: p.head.ref,
      headSha: p.head.sha,
      baseRef: p.base.ref,
      author: p.user.login,
      fromFork: p.head.repo?.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase(),
    }));
  }

  /** Combines check-runs (Actions, apps) and the legacy commit-status API into one verdict. */
  async checks(owner: string, repo: string, ref: string): Promise<CheckState> {
    type Runs = { check_runs: { status: string; conclusion: string | null }[] };
    type Status = { state: 'success' | 'failure' | 'pending' | 'error'; total_count: number };
    const [runs, status] = await Promise.all([
      this.get<Runs>(`/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`),
      this.get<Status>(`/repos/${owner}/${repo}/commits/${ref}/status`),
    ]);
    const states: CheckState[] = runs.check_runs.map((r) => {
      if (r.status !== 'completed') return 'pending';
      return r.conclusion === 'success' || r.conclusion === 'skipped' || r.conclusion === 'neutral' ? 'success' : 'failure';
    });
    if (status.total_count > 0) {
      states.push(status.state === 'success' ? 'success' : status.state === 'pending' ? 'pending' : 'failure');
    }
    if (states.length === 0) return 'none';
    if (states.includes('failure')) return 'failure';
    if (states.includes('pending')) return 'pending';
    return 'success';
  }
}

/** Gets a GitHub session from VS Code's built-in auth. `prompt` shows the consent/sign-in UI if needed. */
export async function getSession(provider: string, prompt: boolean): Promise<vscode.AuthenticationSession | undefined> {
  try {
    return prompt
      ? await vscode.authentication.getSession(provider, SCOPES, { createIfNone: true })
      : await vscode.authentication.getSession(provider, SCOPES, { createIfNone: false, silent: true });
  } catch {
    return undefined; // user cancelled, or provider (e.g. github-enterprise) not configured
  }
}
