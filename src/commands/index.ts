import * as vscode from 'vscode';
import { openFileDiff, openMultiDiff } from '../diff/openDiff';
import { GitError } from '../git/exec';
import { GitRepository } from '../git/repository';
import { RepoManager } from '../model/repoManager';
import { CommitPanel } from '../views/commitPanel';
import { FileNode, FilesView, filesUnder } from '../views/filesView';
import { repoSummary } from '../views/reposView';
import { registerSafe, requireActive as requireActiveRepo, withProgress } from './util';

interface Deps {
  repos: RepoManager;
  filesView: FilesView;
  state: vscode.Memento;
  extensionUri: vscode.Uri;
}

export function registerCommands(context: vscode.ExtensionContext, deps: Deps): void {
  const { repos, filesView } = deps;

  /** Resolves the nodes a command should act on: explicit args, else the tree selection. */
  const targets = (node?: FileNode, nodes?: FileNode[]): FileNode[] => {
    if (nodes?.length) return nodes;
    if (node) return [node];
    return [...filesView.selection];
  };

  const requireActive = () => requireActiveRepo(repos);
  const register = (id: string, fn: (...args: any[]) => unknown) => registerSafe(context, id, fn);

  // ---------------------------------------------------------------- repos

  register('sourcestudio.refresh', () => repos.rescan());

  register('sourcestudio.setActiveRepo', (repo: GitRepository) => repos.setActive(repo));

  register('sourcestudio.pickActiveRepo', async () => {
    const picked = await vscode.window.showQuickPick(
      repos.repositories.map((r) => ({ label: r.name, description: repoSummary(r), detail: r.root, repo: r })),
      { placeHolder: 'Active repository' },
    );
    if (picked) repos.setActive(picked.repo);
  });

  // ---------------------------------------------------------------- files

  register('sourcestudio.openDiff', async (node?: FileNode) => {
    const [first] = targets(node);
    if (!first || first.type === 'group') return;
    if (first.type === 'file') {
      await openFileDiff(first.repo, first.file, first.area);
    } else {
      await openMultiDiff(first.repo, filesUnder(first), first.area, `${first.relPath} (${first.area})`);
    }
  });

  register('sourcestudio.openFile', async (node?: FileNode) => {
    for (const n of targets(node)) {
      if (n.type === 'file') await vscode.window.showTextDocument(n.repo.fileUri(n.file.path), { preview: false });
    }
  });

  register('sourcestudio.stage', async (node?: FileNode, nodes?: FileNode[]) => {
    await withPaths(targets(node, nodes), (repo, paths) => repo.stage(paths));
  });

  register('sourcestudio.unstage', async (node?: FileNode, nodes?: FileNode[]) => {
    await withPaths(targets(node, nodes), (repo, paths) => repo.unstage(paths));
  });

  register('sourcestudio.toggleStage', async (node?: FileNode, nodes?: FileNode[]) => {
    const sel = targets(node, nodes);
    const staged = sel.filter((n) => n.area === 'staged');
    const unstaged = sel.filter((n) => n.area !== 'staged' && n.area !== 'conflicted');
    await withPaths(unstaged, (repo, paths) => repo.stage(paths));
    await withPaths(staged, (repo, paths) => repo.unstage(paths));
  });

  register('sourcestudio.stageAll', async () => {
    const repo = requireActive();
    if (repo) {
      await repo.stageAll();
      await repo.refresh();
    }
  });

  register('sourcestudio.unstageAll', async () => {
    const repo = requireActive();
    if (repo) {
      await repo.unstageAll();
      await repo.refresh();
    }
  });

  register('sourcestudio.discard', async (node?: FileNode, nodes?: FileNode[]) => {
    const sel = targets(node, nodes).filter((n) => n.area === 'unstaged' || n.area === 'untracked');
    const files = sel.flatMap((n) => filesUnder(n).map((f) => ({ repo: n.repo, area: n.area, file: f })));
    if (files.length === 0) return;

    const what = files.length === 1 ? files[0].file.path : `${files.length} files`;
    const ok = await vscode.window.showWarningMessage(
      `Discard changes to ${what}? This cannot be undone.`,
      { modal: true },
      'Discard',
    );
    if (ok !== 'Discard') return;

    const byRepo = new Map<GitRepository, { tracked: string[]; untracked: string[] }>();
    for (const { repo, area, file } of files) {
      const bucket = byRepo.get(repo) ?? { tracked: [], untracked: [] };
      (area === 'untracked' ? bucket.untracked : bucket.tracked).push(file.path);
      byRepo.set(repo, bucket);
    }
    for (const [repo, { tracked, untracked }] of byRepo) {
      await repo.discard(tracked, untracked);
      await repo.refresh();
    }
  });

  // ---------------------------------------------------------------- commit / remote

  register('sourcestudio.commit', async () => {
    const repo = requireActive();
    if (!repo) return;
    await repo.refresh();
    const staged = repo.status.files.some((f) => f.index !== '.' && f.kind === 'tracked');
    if (!staged && repo.status.files.length > 0) {
      const choice = await vscode.window.showInformationMessage('Nothing staged. Stage all changes first?', 'Stage All', 'Open Anyway');
      if (!choice) return;
      if (choice === 'Stage All') {
        await repo.stageAll();
        await repo.refresh();
      }
    }
    CommitPanel.show(repos, repo, deps.state, deps.extensionUri);
  });

  register('sourcestudio.push', async () => {
    const repo = requireActive();
    if (!repo) return;
    await withProgress(`Pushing ${repo.name}…`, async () => {
      try {
        await repo.push();
      } catch (e) {
        if (e instanceof GitError && /no upstream branch|has no upstream/i.test(e.stderr)) {
          const choice = await vscode.window.showInformationMessage(
            `Branch ${repo.status.head} has no upstream. Push and set upstream to origin?`,
            'Push',
          );
          if (choice === 'Push') await repo.push({ setUpstream: true });
          return;
        }
        throw e;
      }
    });
    await repo.refresh();
  });

  register('sourcestudio.pull', async () => {
    const repo = requireActive();
    if (!repo) return;
    await withProgress(`Pulling ${repo.name}…`, () => repo.pull());
    await repo.refresh();
  });

  register('sourcestudio.fetch', async () => {
    const repo = requireActive();
    if (!repo) return;
    await withProgress(`Fetching ${repo.name}…`, () => repo.fetch());
    await repo.refresh();
  });

  register('sourcestudio.showKeymap', async () => {
    const rows: [string, string][] = [
      ['space', 'Stage / unstage selection'],
      ['a', 'Stage all'],
      ['d', 'Discard selection'],
      ['c', 'Commit'],
      ['P', 'Push'],
      ['p', 'Pull'],
      ['f', 'Fetch'],
      ['s', 'Stash (Files view)'],
      ['z / Z', 'Undo / redo last action (reflog-based)'],
      ['R', 'Refresh (Repos/Files) · Rename (Branches)'],
      ['1 – 6', 'Focus Repos / Files / Branches / Worktrees / Commits / Stashes'],
      ['?', 'This keymap'],
      ['alt+b', 'Toggle file blame (in an editor)'],
      ['alt+g', 'Open current line on GitHub (in an editor)'],
      ['— In a diff editor —', ''],
      ['alt+s / alt+h', 'Stage selected lines / hunk at cursor'],
      ['alt+u / alt+shift+h', 'Unstage selected lines / hunk (in the HEAD ↔ Index diff)'],
      ['— Branches —', ''],
      ['space', 'Checkout'],
      ['n', 'New branch from selected'],
      ['d', 'Delete'],
      ['r', 'Rebase current onto selected'],
      ['M', 'Merge selected into current'],
      ['u', 'Set upstream'],
      ['o', 'Open pull request (or create one on GitHub)'],
      ['— Worktrees —', ''],
      ['space', 'Switch to worktree'],
      ['n', 'New worktree'],
      ['d', 'Remove worktree'],
      ['— Commits —', ''],
      ['j / k  ·  enter', 'Move  ·  show diff'],
      ['space', 'Checkout (detached)'],
      ['n', 'New branch at commit'],
      ['c', 'Cherry-pick onto current'],
      ['t', 'Revert'],
      ['g', 'Reset to commit (soft/mixed/hard)'],
      ['y', 'Copy SHA'],
      ['a', 'Toggle all branches'],
      ['o', 'Open commit on GitHub'],
      ['s / f', 'Squash / fixup into parent'],
      ['r', 'Reword'],
      ['d', 'Drop'],
      ['e', 'Edit (pause rebase here)'],
      ['J / K', 'Move commit down / up'],
      ['A', 'Amend HEAD with staged changes (also in Files)'],
      ['— Stashes —', ''],
      ['space', 'Apply'],
      ['g', 'Pop'],
      ['d', 'Drop'],
      ['n', 'New stash'],
    ];
    await vscode.window.showQuickPick(
      rows.map(([key, desc]) => ({ label: key, description: desc })),
      { placeHolder: 'Source Studio keymap (keys work while a Source Studio view has focus)' },
    );
  });
}

// ------------------------------------------------------------------ helpers

/** Groups nodes by repository and runs `fn` with the file paths under them, then refreshes. */
async function withPaths(nodes: FileNode[], fn: (repo: GitRepository, paths: string[]) => Promise<void>): Promise<void> {
  const byRepo = new Map<GitRepository, Set<string>>();
  for (const n of nodes) {
    const set = byRepo.get(n.repo) ?? new Set<string>();
    for (const f of filesUnder(n)) set.add(f.path);
    byRepo.set(n.repo, set);
  }
  for (const [repo, paths] of byRepo) {
    try {
      await fn(repo, [...paths]);
    } finally {
      await repo.refresh();
    }
  }
}
