import * as vscode from 'vscode';
import { openRefDiff } from '../diff/openDiff';
import { EMPTY_TREE, ResetMode } from '../git/types';
import { RepoManager } from '../model/repoManager';
import { CommitContext, CommitsView } from '../views/commitsView';
import { confirm, registerSafe, runOperation } from './util';

interface Deps {
  repos: RepoManager;
  commitsView: CommitsView;
}

/** Arg shape when invoked from the webview context menu (data-vscode-context). */
interface WebviewContext {
  webviewSection?: string;
  sha?: string;
}

export function registerCommitCommands(context: vscode.ExtensionContext, { repos, commitsView }: Deps): void {
  /** Accepts either a full CommitContext (from the webview messages) or a webview menu context. */
  const resolve = (arg?: CommitContext | WebviewContext) => {
    const ctx = arg && 'parents' in arg ? arg : arg?.sha ? commitsView.commit(arg.sha) : undefined;
    if (!ctx) return undefined;
    const repo = repos.repositories.find((r) => r.root === ctx.repoRoot);
    return repo ? { repo, ...ctx } : undefined;
  };

  registerSafe(context, 'sourcestudio.showCommit', async (arg?: CommitContext | WebviewContext) => {
    const t = resolve(arg);
    if (!t) return;
    const parent = t.parents[0] ?? EMPTY_TREE;
    await openRefDiff(t.repo, parent, t.sha, `${t.sha.slice(0, 7)}: ${t.subject}`);
  });

  registerSafe(context, 'sourcestudio.checkoutCommit', async (arg?: CommitContext | WebviewContext) => {
    const t = resolve(arg);
    if (!t) return;
    if (!(await confirm(`Check out ${t.sha.slice(0, 7)} in detached HEAD state?`, 'Checkout'))) return;
    await runOperation(t.repo, `Checking out ${t.sha.slice(0, 7)}`, () => t.repo.checkoutDetached(t.sha));
  });

  registerSafe(context, 'sourcestudio.branchFromCommit', async (arg?: CommitContext | WebviewContext) => {
    const t = resolve(arg);
    if (!t) return;
    const name = await vscode.window.showInputBox({ prompt: `New branch at ${t.sha.slice(0, 7)} "${t.subject}"`, placeHolder: 'branch-name' });
    if (!name) return;
    await t.repo.createBranch(name, t.sha);
    await t.repo.refresh();
  });

  registerSafe(context, 'sourcestudio.cherryPick', async (arg?: CommitContext | WebviewContext) => {
    const t = resolve(arg);
    if (!t) return;
    const current = t.repo.currentBranch?.name ?? 'HEAD';
    if (!(await confirm(`Cherry-pick ${t.sha.slice(0, 7)} "${t.subject}" onto ${current}?`, 'Cherry-pick'))) return;
    await runOperation(t.repo, `Cherry-picking ${t.sha.slice(0, 7)}`, () => t.repo.cherryPick(t.sha));
  });

  registerSafe(context, 'sourcestudio.revertCommit', async (arg?: CommitContext | WebviewContext) => {
    const t = resolve(arg);
    if (!t) return;
    if (!(await confirm(`Revert ${t.sha.slice(0, 7)} "${t.subject}"? This creates a new commit.`, 'Revert'))) return;
    await runOperation(t.repo, `Reverting ${t.sha.slice(0, 7)}`, () => t.repo.revert(t.sha));
  });

  registerSafe(context, 'sourcestudio.resetToCommit', async (arg?: CommitContext | WebviewContext) => {
    const t = resolve(arg);
    if (!t) return;
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'Soft', detail: 'Move HEAD; keep index and working tree', mode: 'soft' as ResetMode },
        { label: 'Mixed', detail: 'Move HEAD and reset index; keep working tree', mode: 'mixed' as ResetMode },
        { label: 'Hard', detail: 'Move HEAD, reset index AND discard working tree changes', mode: 'hard' as ResetMode },
      ],
      { placeHolder: `Reset ${t.repo.currentBranch?.name ?? 'HEAD'} to ${t.sha.slice(0, 7)}` },
    );
    if (!picked) return;
    if (picked.mode === 'hard' && !(await confirm(`Hard reset to ${t.sha.slice(0, 7)}? Uncommitted changes will be lost.`, 'Hard Reset'))) return;
    await t.repo.reset(t.sha, picked.mode);
    await t.repo.refresh();
  });

  registerSafe(context, 'sourcestudio.copySha', async (arg?: CommitContext | WebviewContext) => {
    const t = resolve(arg);
    if (!t) return;
    await vscode.env.clipboard.writeText(t.sha);
    vscode.window.setStatusBarMessage(`Copied ${t.sha.slice(0, 7)}`, 2000);
  });
}
