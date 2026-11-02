import * as vscode from 'vscode';
import { openRefDiff } from '../diff/openDiff';
import { GitError } from '../git/exec';
import { RepoManager } from '../model/repoManager';
import { StashesView, StashNode } from '../views/stashesView';
import { confirm, registerSafe, requireActive } from './util';

interface Deps {
  repos: RepoManager;
  stashesView: StashesView;
}

export function registerStashCommands(context: vscode.ExtensionContext, { repos, stashesView }: Deps): void {
  const target = (node?: StashNode) => node ?? stashesView.selected;

  /** Apply/pop can fail on conflicts; surface that like merge does. */
  const applyLike = async (node: StashNode, pop: boolean) => {
    const { repo, stash } = node;
    try {
      if (pop) await repo.stashPop(stash.ref);
      else await repo.stashApply(stash.ref);
    } catch (e) {
      if (e instanceof GitError && /conflict/i.test(e.stderr)) {
        void vscode.window.showWarningMessage(
          `Applying ${stash.ref} produced conflicts. Resolve them in the Files view${pop ? '; the stash was kept' : ''}.`,
        );
      } else {
        throw e;
      }
    } finally {
      await repo.refresh();
    }
  };

  registerSafe(context, 'sourcestudio.showStash', async (node?: StashNode) => {
    const t = target(node);
    if (!t) return;
    await openRefDiff(t.repo, `${t.stash.ref}^`, t.stash.ref, `${t.stash.ref}: ${t.stash.message}`);
  });

  registerSafe(context, 'sourcestudio.applyStash', async (node?: StashNode) => {
    const t = target(node);
    if (t) await applyLike(t, false);
  });

  registerSafe(context, 'sourcestudio.popStash', async (node?: StashNode) => {
    const t = target(node);
    if (t) await applyLike(t, true);
  });

  registerSafe(context, 'sourcestudio.dropStash', async (node?: StashNode) => {
    const t = target(node);
    if (!t) return;
    if (!(await confirm(`Drop ${t.stash.ref} "${t.stash.message}"? This cannot be undone.`, 'Drop'))) return;
    await t.repo.stashDrop(t.stash.ref);
    await t.repo.refresh();
  });

  registerSafe(context, 'sourcestudio.createStash', async () => {
    const repo = requireActive(repos);
    if (!repo) return;
    if (repo.status.files.length === 0) {
      void vscode.window.showInformationMessage('Nothing to stash.');
      return;
    }
    const hasStaged = repo.status.files.some((f) => f.index !== '.' && f.kind === 'tracked');
    const hasUntracked = repo.status.files.some((f) => f.kind === 'untracked');
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Stash all changes', detail: 'Tracked files, staged and unstaged', mode: 'all' as const },
        ...(hasStaged ? [{ label: 'Stash staged changes only', detail: 'git stash push --staged', mode: 'staged' as const }] : []),
        ...(hasUntracked
          ? [{ label: 'Stash all changes including untracked', detail: 'git stash push --include-untracked', mode: 'untracked' as const }]
          : []),
      ],
      { placeHolder: 'What to stash' },
    );
    if (!choice) return;
    const message = await vscode.window.showInputBox({ prompt: 'Stash message (optional)', ignoreFocusOut: true });
    if (message === undefined) return;
    await repo.stashPush({
      message: message || undefined,
      staged: choice.mode === 'staged',
      includeUntracked: choice.mode === 'untracked',
    });
    await repo.refresh();
  });
}
