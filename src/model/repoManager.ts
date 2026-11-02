import * as path from 'node:path';
import * as vscode from 'vscode';
import { discoverRepositories } from '../git/discovery';
import { GitRepository } from '../git/repository';

const ACTIVE_KEY = 'sourcestudio.activeRepo';

/**
 * Owns every GitRepository in the workspace, tracks which one is "active"
 * (the one the Files/Branches/... views are scoped to), and keeps statuses fresh.
 */
export class RepoManager implements vscode.Disposable {
  private readonly _onDidChangeRepositories = new vscode.EventEmitter<void>();
  readonly onDidChangeRepositories = this._onDidChangeRepositories.event;

  private readonly _onDidChangeActive = new vscode.EventEmitter<GitRepository | undefined>();
  readonly onDidChangeActive = this._onDidChangeActive.event;

  private readonly _onDidChangeStatus = new vscode.EventEmitter<GitRepository>();
  /** Fires whenever any repository's status is re-read. */
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  private _repos: GitRepository[] = [];
  private _active: GitRepository | undefined;
  private repoDisposables = new Map<string, vscode.Disposable[]>();
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly state: vscode.Memento) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.rescan()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sourcestudio.scanDepth') || e.affectsConfiguration('sourcestudio.ignoredFolders')) {
          void this.rescan();
        }
      }),
    );
  }

  get repositories(): readonly GitRepository[] {
    return this._repos;
  }

  get active(): GitRepository | undefined {
    return this._active;
  }

  setActive(repo: GitRepository | undefined): void {
    if (repo === this._active) return;
    this._active = repo;
    void this.state.update(ACTIVE_KEY, repo?.root);
    this._onDidChangeActive.fire(repo);
    this.updateContextKeys();
  }

  /** Context keys drive `when` clauses in package.json (e.g. showing Continue/Abort). */
  private updateContextKeys(): void {
    void vscode.commands.executeCommand('setContext', 'sourcestudio.operation', this._active?.operation ?? '');
  }

  /** Finds the repository whose root contains `fsPath`. */
  repositoryFor(fsPath: string): GitRepository | undefined {
    const norm = path.normalize(fsPath);
    return this._repos
      .filter((r) => norm === r.root || norm.startsWith(r.root + path.sep))
      .sort((a, b) => b.root.length - a.root.length)[0];
  }

  async rescan(): Promise<void> {
    const roots = await discoverRepositories();
    const existing = new Map(this._repos.map((r) => [r.root, r]));

    for (const root of roots) {
      if (!existing.has(root)) this.addRepo(new GitRepository(root));
    }
    for (const [root, repo] of existing) {
      if (!roots.includes(root)) this.removeRepo(repo);
    }
    this._repos.sort((a, b) => a.root.localeCompare(b.root));

    await vscode.commands.executeCommand('setContext', 'sourcestudio.hasRepos', this._repos.length > 0);
    this._onDidChangeRepositories.fire();

    // Restore or choose the active repository.
    const remembered = this.state.get<string>(ACTIVE_KEY);
    const next =
      (this._active && existing.has(this._active.root) && this._active) ||
      this._repos.find((r) => r.root === remembered) ||
      this._repos[0];
    this._active = undefined; // force the event even if `next` is the same object
    this.setActive(next);

    await this.refreshAll();
  }

  refreshAll(): Promise<void[]> {
    return Promise.all(this._repos.map((r) => r.refresh()));
  }

  private addRepo(repo: GitRepository): void {
    this._repos.push(repo);

    const subs: vscode.Disposable[] = [
      repo.onDidChange((r) => {
        if (r === this._active) this.updateContextKeys();
        this._onDidChangeStatus.fire(r);
      }),
    ];

    // Debounced worktree watcher, ignoring anything under .git.
    const schedule = debounce(() => void repo.refresh(), 200);
    const worktree = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repo.rootUri, '**/*'));
    const onWorktreeEvent = (uri: vscode.Uri) => {
      if (!uri.fsPath.includes(`${path.sep}.git${path.sep}`)) schedule();
    };
    subs.push(worktree, worktree.onDidChange(onWorktreeEvent), worktree.onDidCreate(onWorktreeEvent), worktree.onDidDelete(onWorktreeEvent));

    // Fast-path watchers on git internals. In a linked worktree, HEAD/index live in
    // .git/worktrees/<name> while refs live in the main repo's .git, so watch both.
    void (async () => {
      try {
        const [gitDir, commonDir] = await Promise.all([repo.gitDir(), repo.commonDir()]);
        if (!this.repoDisposables.has(repo.root)) return; // removed while resolving
        const watch = (dir: string, glob: string) => {
          const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), glob));
          subs.push(w, w.onDidChange(schedule), w.onDidCreate(schedule), w.onDidDelete(schedule));
        };
        watch(gitDir, '{HEAD,index,ORIG_HEAD,MERGE_HEAD,REBASE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,rebase-merge/**,rebase-apply/**}');
        watch(commonDir, '{packed-refs,refs/**,logs/HEAD,worktrees/**}');
      } catch (e) {
        console.error('[sourcestudio] could not resolve git dir for', repo.root, e);
      }
    })();
    this.repoDisposables.set(repo.root, subs);
  }

  private removeRepo(repo: GitRepository): void {
    this._repos = this._repos.filter((r) => r !== repo);
    this.repoDisposables.get(repo.root)?.forEach((d) => d.dispose());
    this.repoDisposables.delete(repo.root);
    repo.dispose();
  }

  dispose(): void {
    for (const repo of [...this._repos]) this.removeRepo(repo);
    this.disposables.forEach((d) => d.dispose());
    this._onDidChangeRepositories.dispose();
    this._onDidChangeActive.dispose();
    this._onDidChangeStatus.dispose();
  }
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
