import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitError } from '../git/exec';
import { RepoManager } from '../model/repoManager';
import { WorktreeNode, WorktreesView } from '../views/worktreesView';
import { confirm, registerSafe, requireActive, withProgress } from './util';

interface Deps {
  repos: RepoManager;
  worktreesView: WorktreesView;
}

export function registerWorktreeCommands(context: vscode.ExtensionContext, { repos, worktreesView }: Deps): void {
  const target = (node?: WorktreeNode) => node ?? worktreesView.selected;

  registerSafe(context, 'sourcestudio.switchWorktree', async (node?: WorktreeNode) => {
    const t = target(node);
    if (!t) return;
    const wtPath = path.normalize(t.worktree.path);
    if (wtPath === t.repo.root) return;

    // Already open in this workspace? Just make it the active repo.
    const open = repos.repositories.find((r) => r.root === wtPath);
    if (open) {
      repos.setActive(open);
      await vscode.commands.executeCommand('sourcestudio.files.focus');
      return;
    }

    const uri = vscode.Uri.file(wtPath);
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(window) Open in this window', mode: 'here' as const },
        { label: '$(multiple-windows) Open in new window', mode: 'new' as const },
        { label: '$(root-folder) Add to workspace', detail: 'Keeps the current folders and adds this worktree alongside them', mode: 'add' as const },
      ],
      { placeHolder: `Open worktree ${t.worktree.branch ?? path.basename(wtPath)}` },
    );
    if (!choice) return;
    if (choice.mode === 'add') {
      vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri });
    } else {
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: choice.mode === 'new' });
    }
  });

  registerSafe(context, 'sourcestudio.addWorktree', async () => {
    const repo = requireActive(repos);
    if (!repo) return;

    const inUse = new Set(repo.worktrees.map((w) => w.branch).filter(Boolean));
    const locals = repo.branches.filter((b) => !b.remote && !inUse.has(b.name));
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(add) New branch…', mode: 'new' as const, name: '' },
        ...locals.map((b) => ({ label: b.name, description: b.subject, mode: 'existing' as const, name: b.name })),
      ],
      { placeHolder: 'Branch for the new worktree' },
    );
    if (!picked) return;

    let branch = picked.name;
    let newBranch = false;
    if (picked.mode === 'new') {
      const name = await vscode.window.showInputBox({ prompt: `New branch from ${repo.currentBranch?.name ?? 'HEAD'}`, placeHolder: 'branch-name' });
      if (!name) return;
      branch = name;
      newBranch = true;
    }

    const mainRoot = path.normalize(repo.worktrees.find((w) => w.main)?.path ?? repo.root);
    const suggested = path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}-${branch.replace(/[\/\\]/g, '-')}`);
    const wtPath = await vscode.window.showInputBox({ prompt: 'Worktree path', value: suggested, valueSelection: [suggested.length, suggested.length] });
    if (!wtPath) return;

    await withProgress(`Creating worktree for ${branch}`, () => repo.worktreeAdd(wtPath, branch, { newBranch }));
    await repo.refresh();
    const open = await vscode.window.showInformationMessage(`Worktree created at ${wtPath}`, 'Open in New Window', 'Add to Workspace');
    if (open === 'Open in New Window') {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wtPath), { forceNewWindow: true });
    } else if (open === 'Add to Workspace') {
      vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(wtPath) });
    }
  });

  registerSafe(context, 'sourcestudio.removeWorktree', async (node?: WorktreeNode) => {
    const t = target(node);
    if (!t) return;
    const { repo, worktree } = t;
    if (worktree.main) {
      void vscode.window.showWarningMessage('The main worktree cannot be removed.');
      return;
    }
    if (path.normalize(worktree.path) === repo.root) {
      void vscode.window.showWarningMessage('Switch to another worktree before removing this one.');
      return;
    }
    if (!(await confirm(`Remove worktree ${worktree.path}?`, 'Remove'))) return;
    try {
      await repo.worktreeRemove(worktree.path);
    } catch (e) {
      if (e instanceof GitError && /contains modified or untracked files|use --force/i.test(e.stderr)) {
        if (await confirm(`${worktree.path} has uncommitted changes. Remove anyway and lose them?`, 'Force Remove')) {
          await repo.worktreeRemove(worktree.path, true);
        }
      } else {
        throw e;
      }
    }
    await repo.refresh();
  });

  registerSafe(context, 'sourcestudio.pruneWorktrees', async () => {
    const repo = requireActive(repos);
    if (!repo) return;
    await repo.worktreePrune();
    await repo.refresh();
  });
}
