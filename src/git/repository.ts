import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { execGit, GitError } from './exec';
import { Branch, ChangedFile, Commit, EMPTY_STATUS, FileStatus, Operation, ReflogEntry, RepoStatus, ResetMode, Stash, Worktree } from './types';

/**
 * One git working tree. Caches the last parsed status and emits when it changes.
 * All paths passed in/out are relative to `root`, POSIX-style.
 */
export class GitRepository implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<GitRepository>();
  readonly onDidChange = this._onDidChange.event;

  private _status: RepoStatus = EMPTY_STATUS;
  private _branches: Branch[] = [];
  private _operation: Operation | undefined;
  private _stashes: Stash[] = [];
  private _worktrees: Worktree[] = [];
  private _gitDir: string | undefined;
  private refreshing: Promise<void> | undefined;
  private refreshQueued = false;

  constructor(readonly root: string) {}

  get name(): string {
    return path.basename(this.root);
  }

  get status(): RepoStatus {
    return this._status;
  }

  get branches(): readonly Branch[] {
    return this._branches;
  }

  get currentBranch(): Branch | undefined {
    return this._branches.find((b) => b.current);
  }

  get stashes(): readonly Stash[] {
    return this._stashes;
  }

  get worktrees(): readonly Worktree[] {
    return this._worktrees;
  }

  /** The paused operation (rebase, merge, ...) if any. */
  get operation(): Operation | undefined {
    return this._operation;
  }

  get rootUri(): vscode.Uri {
    return vscode.Uri.file(this.root);
  }

  fileUri(relPath: string): vscode.Uri {
    return vscode.Uri.file(path.join(this.root, ...relPath.split('/')));
  }

  // ---------------------------------------------------------------- queries

  /** Re-reads `git status`. Coalesces concurrent calls so at most one runs at a time. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        do {
          this.refreshQueued = false;
          const { stdout } = await this.run([
            'status',
            '--porcelain=v2',
            '--branch',
            '--untracked-files=all',
            '-z',
          ]);
          this._status = parseStatus(stdout);
          const refs = await this.run([
            'for-each-ref',
            '--sort=-committerdate',
            `--format=${BRANCH_FORMAT}`,
            'refs/heads',
            'refs/remotes',
          ]);
          this._branches = parseBranches(refs.stdout);
          this._operation = await this.detectOperation();
          const [stashes, worktrees] = await Promise.all([
            this.run(['stash', 'list', `--format=${STASH_FORMAT}`]),
            this.run(['worktree', 'list', '--porcelain']),
          ]);
          this._stashes = parseStashes(stashes.stdout);
          this._worktrees = parseWorktrees(worktrees.stdout, this.root);
        } while (this.refreshQueued);
      } catch (e) {
        console.error(`[sourcestudio] status failed for ${this.root}`, e);
      } finally {
        this.refreshing = undefined;
        this._onDidChange.fire(this);
      }
    })();
    return this.refreshing;
  }

  /**
   * Returns the content of `relPath` at `ref` (e.g. 'HEAD', ':0' for the index).
   * Returns '' when the file does not exist at that ref, or when ref is ''.
   */
  async show(ref: string, relPath: string): Promise<string> {
    if (!ref) return '';
    try {
      const spec = ref === ':0' ? `:0:${relPath}` : `${ref}:${relPath}`;
      const { stdout } = await this.run(['show', spec]);
      return stdout;
    } catch (e) {
      if (e instanceof GitError) return '';
      throw e;
    }
  }

  /** This worktree's git dir (`.git` or `.git/worktrees/<name>` for linked worktrees). */
  async gitDir(): Promise<string> {
    if (!this._gitDir) {
      const { stdout } = await this.run(['rev-parse', '--git-dir']);
      this._gitDir = path.resolve(this.root, stdout.trim());
    }
    return this._gitDir;
  }

  /** The shared git dir holding refs/objects — differs from gitDir() only in linked worktrees. */
  async commonDir(): Promise<string> {
    const { stdout } = await this.run(['rev-parse', '--git-common-dir']);
    return path.resolve(this.root, stdout.trim());
  }

  /** Commit history, child-before-parent, for HEAD or every ref. */
  async log(opts: { all?: boolean; limit: number; skip?: number }): Promise<Commit[]> {
    const args = ['log', `--format=${LOG_FORMAT}`, '--date-order', `-n${opts.limit}`];
    if (opts.skip) args.push(`--skip=${opts.skip}`);
    args.push(opts.all ? '--all' : 'HEAD');
    try {
      const { stdout } = await this.run(args);
      return parseLog(stdout);
    } catch (e) {
      if (e instanceof GitError) return []; // unborn branch
      throw e;
    }
  }

  /** SHAs on HEAD that the upstream doesn't have yet. */
  async unpushed(): Promise<Set<string>> {
    try {
      const { stdout } = await this.run(['rev-list', '@{u}..HEAD']);
      return new Set(stdout.split('\n').filter(Boolean));
    } catch {
      return new Set(); // no upstream
    }
  }

  private async detectOperation(): Promise<Operation | undefined> {
    const dir = await this.gitDir();
    const exists = (p: string) => fs.access(path.join(dir, p)).then(() => true, () => false);
    if ((await exists('rebase-merge')) || (await exists('rebase-apply'))) return 'rebase';
    if (await exists('MERGE_HEAD')) return 'merge';
    if (await exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
    if (await exists('REVERT_HEAD')) return 'revert';
    return undefined;
  }

  // ---------------------------------------------------------------- actions

  async stage(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.run(['add', '-A', '--', ...paths]);
  }

  async stageAll(): Promise<void> {
    await this.run(['add', '-A']);
  }

  async unstage(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.run(['reset', '-q', '--', ...paths]);
  }

  async unstageAll(): Promise<void> {
    await this.run(['reset', '-q']);
  }

  /** Reverts worktree changes for tracked files and deletes untracked ones. */
  async discard(tracked: string[], untracked: string[]): Promise<void> {
    if (tracked.length) await this.run(['checkout', '--', ...tracked]);
    if (untracked.length) await this.run(['clean', '-f', '-q', '--', ...untracked]);
  }

  async commit(message: string, opts: { amend?: boolean; noVerify?: boolean; signoff?: boolean } = {}): Promise<void> {
    // --cleanup=strip drops '#' comment lines (from templates) the way an editor-based commit would.
    const args = ['commit', '-F', '-', '--cleanup=strip'];
    if (opts.amend) args.push('--amend');
    if (opts.noVerify) args.push('--no-verify');
    if (opts.signoff) args.push('--signoff');
    await this.run(args, message);
  }

  /**
   * Commit message template: `commit.template` from git config first, then each path in
   * `sourcestudio.commit.templateFiles` relative to the repo root. '' when none exist.
   */
  async commitTemplate(): Promise<string> {
    const candidates: string[] = [];
    try {
      const { stdout } = await this.run(['config', '--get', 'commit.template']);
      const configured = stdout.trim();
      if (configured) candidates.push(configured.replace(/^~(?=$|\/)/, os.homedir()));
    } catch {
      /* not configured */
    }
    candidates.push(...vscode.workspace.getConfiguration('sourcestudio.commit').get<string[]>('templateFiles', []));
    for (const c of candidates) {
      try {
        return (await fs.readFile(path.resolve(this.root, c), 'utf8')).replace(/\s+$/, '');
      } catch {
        /* try next */
      }
    }
    return '';
  }

  async fetch(): Promise<void> {
    await this.run(['fetch', '--prune']);
  }

  async pull(): Promise<void> {
    await this.run(['pull']);
  }

  async push(opts: { setUpstream?: boolean; force?: boolean } = {}): Promise<void> {
    const args = ['push'];
    if (opts.force) args.push('--force-with-lease');
    if (opts.setUpstream) args.push('--set-upstream', 'origin', this._status.head);
    await this.run(args);
  }

  /** URL of a remote, or undefined if it doesn't exist. */
  async remoteUrl(name = 'origin'): Promise<string | undefined> {
    try {
      const { stdout } = await this.run(['remote', 'get-url', name]);
      return stdout.trim() || undefined;
    } catch (e) {
      if (e instanceof GitError) return undefined;
      throw e;
    }
  }

  // ---------------------------------------------------------------- branches

  async checkout(name: string): Promise<void> {
    await this.run(['switch', name]);
  }

  /** Checks out `origin/foo` as local `foo`, creating a tracking branch if needed. */
  async checkoutRemote(branch: Branch): Promise<void> {
    const local = branch.name.slice((branch.remote?.length ?? 0) + 1);
    if (this._branches.some((b) => !b.remote && b.name === local)) {
      await this.run(['switch', local]);
    } else {
      await this.run(['switch', '-c', local, '--track', branch.name]);
    }
  }

  async createBranch(name: string, from?: string, checkout = true): Promise<void> {
    if (checkout) {
      await this.run(['switch', '-c', name, ...(from ? [from] : [])]);
    } else {
      await this.run(['branch', name, ...(from ? [from] : [])]);
    }
  }

  async deleteBranch(name: string, force = false): Promise<void> {
    await this.run(['branch', force ? '-D' : '-d', name]);
  }

  async deleteRemoteBranch(remote: string, name: string): Promise<void> {
    await this.run(['push', remote, '--delete', name]);
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.run(['branch', '-m', oldName, newName]);
  }

  async merge(name: string): Promise<void> {
    await this.run(['merge', name]);
  }

  async rebase(onto: string): Promise<void> {
    await this.run(['rebase', onto]);
  }

  /** Fast-forwards `branch` to its upstream without checking it out (or with --ff-only if current). */
  async fastForward(branch: Branch): Promise<void> {
    if (!branch.upstream) throw new Error(`${branch.name} has no upstream`);
    if (branch.current) {
      await this.run(['merge', '--ff-only', branch.upstream]);
    } else {
      const [remote, ...rest] = branch.upstream.split('/');
      await this.run(['fetch', remote, `${rest.join('/')}:${branch.name}`]);
    }
  }

  async setUpstream(branch: string, upstream: string): Promise<void> {
    await this.run(['branch', `--set-upstream-to=${upstream}`, branch]);
  }

  async continueOperation(): Promise<void> {
    if (this._operation) await this.run([this._operation, '--continue']);
  }

  async abortOperation(): Promise<void> {
    if (this._operation) await this.run([this._operation, '--abort']);
  }

  /** Files changed between two refs (e.g. `stash@{0}^` and `stash@{0}`). */
  async changedFiles(from: string, to: string): Promise<ChangedFile[]> {
    const { stdout } = await this.run(['diff', '--name-status', '-z', '-M', from, to]);
    const tokens = stdout.split('\0');
    const files: ChangedFile[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const status = tokens[i];
      if (!status) continue;
      const letter = status[0];
      if (letter === 'R' || letter === 'C') {
        files.push({ status: letter, origPath: tokens[++i], path: tokens[++i] });
      } else {
        files.push({ status: letter, path: tokens[++i] });
      }
    }
    return files;
  }

  // ---------------------------------------------------------------- commits

  async checkoutDetached(sha: string): Promise<void> {
    await this.run(['switch', '--detach', sha]);
  }

  async cherryPick(sha: string): Promise<void> {
    await this.run(['cherry-pick', sha]);
  }

  async revert(sha: string): Promise<void> {
    await this.run(['revert', '--no-edit', sha]);
  }

  async reset(sha: string, mode: ResetMode): Promise<void> {
    await this.run(['reset', `--${mode}`, sha]);
  }

  // ---------------------------------------------------------------- rebase support

  /** Commits in `base..head`, oldest first (as parseLog Commits). */
  async revList(base: string, head = 'HEAD'): Promise<Commit[]> {
    const { stdout } = await this.run(['log', `--format=${LOG_FORMAT}`, '--reverse', `${base}..${head}`]);
    return parseLog(stdout);
  }

  /** Full commit message (subject + body). */
  async fullMessage(sha: string): Promise<string> {
    const { stdout } = await this.run(['log', '-1', '--format=%B', sha]);
    return stdout.replace(/\n+$/, '');
  }

  /** Runs `rebase -i` with editors replaced by the given env (see git/rebase.ts). */
  async rebaseInteractive(base: string, env: NodeJS.ProcessEnv): Promise<void> {
    await execGit(['rebase', '-i', '--autostash', base], { cwd: this.root, env });
  }

  /** Amends HEAD with whatever is staged, keeping the message (or replacing it). */
  async amend(message?: string): Promise<void> {
    if (message === undefined) await this.run(['commit', '--amend', '--no-edit']);
    else await this.run(['commit', '--amend', '-F', '-'], message);
  }

  /** HEAD's reflog, newest first. */
  async reflog(limit = 50): Promise<ReflogEntry[]> {
    try {
      const { stdout } = await this.run(['reflog', 'show', '--date=unix', `--format=${REFLOG_FORMAT}`, `-n${limit}`]);
      return parseReflog(stdout);
    } catch (e) {
      if (e instanceof GitError) return [];
      throw e;
    }
  }

  /** `git blame --porcelain` for a file; pass `contents` to blame unsaved editor text. */
  async blame(relPath: string, contents?: string): Promise<string> {
    const args = ['blame', '--porcelain', ...(contents !== undefined ? ['--contents', '-'] : []), '--', relPath];
    const { stdout } = await this.run(args, contents);
    return stdout;
  }

  // ---------------------------------------------------------------- partial staging

  /** Zero-context diff for one file: index→worktree, or HEAD→index with `cached`. Untracked files are intent-added first. */
  async diffFile(relPath: string, cached = false): Promise<string> {
    const args = ['diff', '--no-color', '--no-ext-diff', '-U0', ...(cached ? ['--cached'] : []), '--', relPath];
    let { stdout } = await this.run(args);
    if (!stdout && !cached && this._status.files.some((f) => f.path === relPath && f.kind === 'untracked')) {
      await this.run(['add', '--intent-to-add', '--', relPath]);
      stdout = (await this.run(args)).stdout;
    }
    return stdout;
  }

  /** Applies a `-U0` patch to the index (`cached`) or the worktree, optionally in reverse. */
  async applyPatch(patch: string, opts: { cached?: boolean; reverse?: boolean }): Promise<void> {
    const args = ['apply', '--unidiff-zero', '--whitespace=nowarn'];
    if (opts.cached) args.push('--cached');
    if (opts.reverse) args.push('-R');
    args.push('-');
    await this.run(args, patch);
  }

  // ---------------------------------------------------------------- stashes

  async stashPush(opts: { message?: string; staged?: boolean; includeUntracked?: boolean } = {}): Promise<void> {
    const args = ['stash', 'push'];
    if (opts.staged) args.push('--staged');
    if (opts.includeUntracked) args.push('--include-untracked');
    if (opts.message) args.push('-m', opts.message);
    await this.run(args);
  }

  async stashApply(ref: string): Promise<void> {
    await this.run(['stash', 'apply', ref]);
  }

  async stashPop(ref: string): Promise<void> {
    await this.run(['stash', 'pop', ref]);
  }

  async stashDrop(ref: string): Promise<void> {
    await this.run(['stash', 'drop', ref]);
  }

  // ---------------------------------------------------------------- worktrees

  /** Adds a worktree at `wtPath`. With `newBranch`, creates it (from `from` or HEAD); otherwise checks out `branch`. */
  async worktreeAdd(wtPath: string, branch: string, opts: { newBranch?: boolean; from?: string } = {}): Promise<void> {
    const args = ['worktree', 'add'];
    if (opts.newBranch) args.push('-b', branch, wtPath, ...(opts.from ? [opts.from] : []));
    else args.push(wtPath, branch);
    await this.run(args);
  }

  async worktreeRemove(wtPath: string, force = false): Promise<void> {
    await this.run(['worktree', 'remove', ...(force ? ['--force'] : []), wtPath]);
  }

  async worktreePrune(): Promise<void> {
    await this.run(['worktree', 'prune']);
  }

  // ---------------------------------------------------------------- plumbing

  run(args: string[], stdin?: string) {
    return execGit(args, { cwd: this.root, stdin });
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

// ------------------------------------------------------------------ parsing

/** Splits `s` on `sep` into at most `n` parts; the last part keeps the remainder. */
function splitN(s: string, sep: string, n: number): string[] {
  const parts: string[] = [];
  let rest = s;
  while (parts.length < n - 1) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    parts.push(rest.slice(0, i));
    rest = rest.slice(i + sep.length);
  }
  parts.push(rest);
  return parts;
}

/** Parses `git status --porcelain=v2 --branch -z` output. */
export function parseStatus(out: string): RepoStatus {
  const status: RepoStatus = { ...EMPTY_STATUS, files: [] };
  const tokens = out.split('\0');

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;

    if (t.startsWith('# ')) {
      const [key, ...rest] = t.slice(2).split(' ');
      const value = rest.join(' ');
      switch (key) {
        case 'branch.oid':
          status.oid = value;
          break;
        case 'branch.head':
          status.head = value;
          break;
        case 'branch.upstream':
          status.upstream = value;
          break;
        case 'branch.ab': {
          const m = /\+(\d+) -(\d+)/.exec(value);
          if (m) {
            status.ahead = Number(m[1]);
            status.behind = Number(m[2]);
          }
          break;
        }
      }
      continue;
    }

    switch (t[0]) {
      case '1': {
        // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        const p = splitN(t, ' ', 9);
        status.files.push({ path: p[8], index: p[1][0], worktree: p[1][1], kind: 'tracked' });
        break;
      }
      case '2': {
        // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>  NUL <origPath>
        const p = splitN(t, ' ', 10);
        const origPath = tokens[++i];
        status.files.push({ path: p[9], origPath, index: p[1][0], worktree: p[1][1], kind: 'tracked' });
        break;
      }
      case 'u': {
        // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
        const p = splitN(t, ' ', 11);
        status.files.push({ path: p[10], index: p[1][0], worktree: p[1][1], kind: 'unmerged' });
        break;
      }
      case '?':
        status.files.push({ path: t.slice(2), index: '.', worktree: '?', kind: 'untracked' });
        break;
      // '!' ignored entries are not requested
    }
  }

  status.files.sort((a, b) => a.path.localeCompare(b.path));
  return status;
}

const BRANCH_FORMAT = [
  '%(refname)',
  '%(objectname:short)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(committerdate:unix)',
  '%(HEAD)',
  '%(symref)',
  '%(subject)',
].join('%00');

/** Parses `git for-each-ref --format=BRANCH_FORMAT refs/heads refs/remotes` output. */
export function parseBranches(out: string): Branch[] {
  const branches: Branch[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [fullRef, sha, upstream, track, date, head, symref, subject] = line.split('\0');
    if (symref) continue; // e.g. refs/remotes/origin/HEAD -> origin/main

    let name: string;
    let remote: string | undefined;
    if (fullRef.startsWith('refs/heads/')) {
      name = fullRef.slice('refs/heads/'.length);
    } else if (fullRef.startsWith('refs/remotes/')) {
      name = fullRef.slice('refs/remotes/'.length);
      remote = name.split('/')[0];
    } else {
      continue;
    }

    branches.push({
      name,
      fullRef,
      remote,
      sha,
      upstream: upstream || undefined,
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      upstreamGone: track.includes('gone'),
      date: Number(date),
      subject,
      current: head === '*',
    });
  }
  return branches;
}

const LOG_FORMAT = '%H%x00%P%x00%an%x00%at%x00%D%x00%s';

/** Parses `git log --format=LOG_FORMAT`. */
export function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [sha, parents, author, date, refs, subject] = line.split('\0');
    commits.push({
      sha,
      parents: parents ? parents.split(' ') : [],
      author,
      date: Number(date),
      refs: refs ? refs.split(', ').map((r) => r.replace(/^HEAD -> /, '')) : [],
      subject: subject ?? '',
    });
  }
  return commits;
}

const REFLOG_FORMAT = '%H%x00%gd%x00%gs';

/** Parses `git reflog show --date=unix --format=REFLOG_FORMAT`; %gd is `HEAD@{<unix>}` with --date=unix. */
export function parseReflog(out: string): ReflogEntry[] {
  const entries: ReflogEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [sha, selector, subject] = line.split('\0');
    entries.push({ index: entries.length, sha, subject, date: Number(/\{(\d+)\}/.exec(selector)?.[1] ?? 0) });
  }
  return entries;
}

const STASH_FORMAT = '%gd%x00%gs%x00%at';

/** Parses `git stash list --format=STASH_FORMAT`. */
export function parseStashes(out: string): Stash[] {
  const stashes: Stash[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [ref, subject, date] = line.split('\0');
    const index = Number(/\{(\d+)\}/.exec(ref)?.[1] ?? stashes.length);
    // Subject looks like "On main: message" or "WIP on main: abc1234 Commit title".
    const message = subject.replace(/^(WIP on|On) [^:]+: /, '');
    stashes.push({ ref, index, message, date: Number(date) });
  }
  return stashes;
}

/** Parses `git worktree list --porcelain`. The first entry is always the main worktree. */
export function parseWorktrees(out: string, _root: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | undefined;
  for (const line of out.split('\n')) {
    if (!line) {
      if (current) worktrees.push(current);
      current = undefined;
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    switch (key) {
      case 'worktree':
        current = { path: value, head: '', detached: false, bare: false, main: worktrees.length === 0 };
        break;
      case 'HEAD':
        if (current) current.head = value;
        break;
      case 'branch':
        if (current) current.branch = value.replace(/^refs\/heads\//, '');
        break;
      case 'detached':
        if (current) current.detached = true;
        break;
      case 'bare':
        if (current) current.bare = true;
        break;
      case 'locked':
        if (current) current.locked = value || 'locked';
        break;
      case 'prunable':
        if (current) current.prunable = value || 'prunable';
        break;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

export type { FileStatus };
