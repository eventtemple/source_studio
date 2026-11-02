import * as vscode from 'vscode';
import { GitError } from '../git/exec';
import { GitRepository } from '../git/repository';
import { Branch } from '../git/types';
import { RepoManager } from '../model/repoManager';
import { BranchNode, BranchesView } from '../views/branchesView';
import { confirm, registerSafe, requireActive, runOperation, withProgress } from './util';

interface Deps {
  repos: RepoManager;
  branchesView: BranchesView;
}

export function registerBranchCommands(context: vscode.ExtensionContext, { repos, branchesView }: Deps): void {
  /** Resolves the branch a command acts on: the clicked node, else the selection. */
  const target = (node?: BranchNode): { repo: GitRepository; branch: Branch } | undefined => {
    const n = node?.type === 'branch' ? node : branchesView.selectedBranch;
    return n ? { repo: n.repo, branch: n.branch } : undefined;
  };

  registerSafe(context, 'sourcestudio.checkoutBranch', async (node?: BranchNode) => {
    const t = target(node);
    if (!t || t.branch.current) return;
    await runOperation(t.repo, `Checking out ${t.branch.name}`, () =>
      t.branch.remote ? t.repo.checkoutRemote(t.branch) : t.repo.checkout(t.branch.name),
    );
  });

  registerSafe(context, 'sourcestudio.newBranch', async (node?: BranchNode) => {
    const repo = node?.type === 'branch' ? node.repo : requireActive(repos);
    if (!repo) return;
    const from = node?.type === 'branch' ? node.branch : repo.currentBranch;
    const name = await vscode.window.showInputBox({
      prompt: from ? `New branch from ${from.name}` : 'New branch',
      placeHolder: 'branch-name',
      validateInput: validateBranchName,
    });
    if (!name) return;
    await repo.createBranch(name, from?.name);
    await repo.refresh();
  });

  registerSafe(context, 'sourcestudio.deleteBranch', async (node?: BranchNode) => {
    const t = target(node);
    if (!t) return;
    const { repo, branch } = t;

    if (branch.remote) {
      const name = branch.name.slice(branch.remote.length + 1);
      if (!(await confirm(`Delete ${branch.name} on the remote? This affects everyone.`, 'Delete Remote Branch'))) return;
      await withProgress(`Deleting ${branch.name}`, () => repo.deleteRemoteBranch(branch.remote!, name));
      await repo.refresh();
      return;
    }

    if (branch.current) {
      void vscode.window.showWarningMessage('Cannot delete the checked-out branch. Check out another branch first.');
      return;
    }
    if (!(await confirm(`Delete local branch ${branch.name}?`, 'Delete'))) return;
    try {
      await repo.deleteBranch(branch.name);
    } catch (e) {
      if (e instanceof GitError && /not fully merged/i.test(e.stderr)) {
        if (await confirm(`${branch.name} is not fully merged. Force delete?`, 'Force Delete')) {
          await repo.deleteBranch(branch.name, true);
        }
      } else {
        throw e;
      }
    }
    await repo.refresh();
  });

  registerSafe(context, 'sourcestudio.renameBranch', async (node?: BranchNode) => {
    const t = target(node);
    if (!t || t.branch.remote) return;
    const name = await vscode.window.showInputBox({
      prompt: `Rename ${t.branch.name}`,
      value: t.branch.name,
      valueSelection: [0, t.branch.name.length],
      validateInput: validateBranchName,
    });
    if (!name || name === t.branch.name) return;
    await t.repo.renameBranch(t.branch.name, name);
    await t.repo.refresh();
  });

  registerSafe(context, 'sourcestudio.rebaseOnto', async (node?: BranchNode) => {
    const t = target(node);
    if (!t || t.branch.current) return;
    const current = t.repo.currentBranch?.name ?? 'HEAD';
    if (!(await confirm(`Rebase ${current} onto ${t.branch.name}?`, 'Rebase'))) return;
    await runOperation(t.repo, `Rebasing ${current} onto ${t.branch.name}`, () => t.repo.rebase(t.branch.name));
  });

  registerSafe(context, 'sourcestudio.mergeInto', async (node?: BranchNode) => {
    const t = target(node);
    if (!t || t.branch.current) return;
    const current = t.repo.currentBranch?.name ?? 'HEAD';
    if (!(await confirm(`Merge ${t.branch.name} into ${current}?`, 'Merge'))) return;
    await runOperation(t.repo, `Merging ${t.branch.name} into ${current}`, () => t.repo.merge(t.branch.name));
  });

  registerSafe(context, 'sourcestudio.fastForward', async (node?: BranchNode) => {
    const t = target(node);
    if (!t || t.branch.remote) return;
    await runOperation(t.repo, `Fast-forwarding ${t.branch.name}`, () => t.repo.fastForward(t.branch));
  });

  registerSafe(context, 'sourcestudio.setUpstream', async (node?: BranchNode) => {
    const t = target(node);
    if (!t || t.branch.remote) return;
    const remotes = t.repo.branches.filter((b) => b.remote);
    const picked = await vscode.window.showQuickPick(
      remotes.map((b) => ({ label: b.name, description: b.name === t.branch.upstream ? 'current upstream' : '', branch: b })),
      { placeHolder: `Upstream for ${t.branch.name}` },
    );
    if (!picked) return;
    await t.repo.setUpstream(t.branch.name, picked.branch.name);
    await t.repo.refresh();
  });

  registerSafe(context, 'sourcestudio.continueOperation', async () => {
    const repo = requireActive(repos);
    if (!repo?.operation) return;
    await runOperation(repo, `Continuing ${repo.operation}`, () => repo.continueOperation());
  });

  registerSafe(context, 'sourcestudio.abortOperation', async () => {
    const repo = requireActive(repos);
    if (!repo?.operation) return;
    if (!(await confirm(`Abort the ${repo.operation} in progress?`, 'Abort'))) return;
    await repo.abortOperation();
    await repo.refresh();
  });
}

function validateBranchName(value: string): string | undefined {
  if (!value.trim()) return 'Branch name is required';
  if (/[\s~^:?*\[\\]|\.\.|@\{|^-|\/$|\.lock$|^\/|\/\//.test(value)) return 'Invalid branch name';
  return undefined;
}
