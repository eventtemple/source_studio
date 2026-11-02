/** Which section of the Files view a change belongs to. */
export type Area = 'staged' | 'unstaged' | 'untracked' | 'conflicted';

export interface FileStatus {
  /** Path relative to the repo root, POSIX separators. */
  path: string;
  /** Original path for renames/copies. */
  origPath?: string;
  /** Index status letter (X in porcelain). '.' means unchanged. */
  index: string;
  /** Worktree status letter (Y in porcelain). '.' means unchanged. */
  worktree: string;
  kind: 'tracked' | 'untracked' | 'unmerged';
}

export interface RepoStatus {
  /** Branch name, or '(detached)' when HEAD is detached. */
  head: string;
  /** Commit OID of HEAD, or '(initial)' on an unborn branch. */
  oid: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: FileStatus[];
}

export const EMPTY_STATUS: RepoStatus = {
  head: '(unknown)',
  oid: '',
  ahead: 0,
  behind: 0,
  files: [],
};

/** Returns the areas a status entry appears in (a file can be both staged and unstaged). */
export function areasOf(f: FileStatus): Area[] {
  if (f.kind === 'untracked') return ['untracked'];
  if (f.kind === 'unmerged') return ['conflicted'];
  const areas: Area[] = [];
  if (f.index !== '.') areas.push('staged');
  if (f.worktree !== '.') areas.push('unstaged');
  return areas;
}

export function statusLetter(f: FileStatus, area: Area): string {
  switch (area) {
    case 'staged':
      return f.index;
    case 'unstaged':
      return f.worktree;
    case 'untracked':
      return '?';
    case 'conflicted':
      return 'U';
  }
}

export interface Branch {
  /** Short name: `main` for local, `origin/main` for remote-tracking. */
  name: string;
  fullRef: string;
  /** Remote name for remote-tracking branches; undefined for local branches. */
  remote?: string;
  sha: string;
  upstream?: string;
  ahead: number;
  behind: number;
  /** Upstream is configured but no longer exists on the remote. */
  upstreamGone: boolean;
  /** Committer date, unix seconds. */
  date: number;
  subject: string;
  current: boolean;
}

/** A multi-step git operation that is paused (usually on conflicts). */
export type Operation = 'rebase' | 'merge' | 'cherry-pick' | 'revert';

export interface Stash {
  /** `stash@{0}` */
  ref: string;
  index: number;
  message: string;
  /** Unix seconds. */
  date: number;
}

export interface Worktree {
  /** Absolute path. */
  path: string;
  head: string;
  /** Short branch name, undefined when detached or bare. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked?: string;
  prunable?: string;
  /** True for the main working tree (the one with the real .git directory). */
  main: boolean;
}

/** One entry of `git diff --name-status` between two refs. */
export interface ChangedFile {
  path: string;
  origPath?: string;
  /** A, M, D, R, C, T */
  status: string;
}

export interface Commit {
  sha: string;
  parents: string[];
  author: string;
  /** Unix seconds. */
  date: number;
  /** Decorations from %D: `HEAD -> main`, `origin/main`, `tag: v1.0`. */
  refs: string[];
  subject: string;
}

export type ResetMode = 'soft' | 'mixed' | 'hard';

/** SHA of git's empty tree — the "parent" of a root commit for diffing purposes. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface ReflogEntry {
  /** 0 = current HEAD state. */
  index: number;
  sha: string;
  /** e.g. "commit: Fix typo", "checkout: moving from main to feature", "rebase (finish): ..." */
  subject: string;
  /** Unix seconds. */
  date: number;
}
