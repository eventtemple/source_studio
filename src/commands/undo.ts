import * as vscode from 'vscode';
import { GitRepository } from '../git/repository';
import { ReflogEntry } from '../git/types';
import { RepoManager } from '../model/repoManager';
import { confirm, registerSafe, relativeAge, requireActive } from './util';

interface Deps {
  repos: RepoManager;
}

/** What it takes to get back to a state — and therefore what "redo" has to reverse. */
type Step = { kind: 'reset'; sha: string; label: string } | { kind: 'switch'; branch: string; label: string };

/** Works out how to undo the most recent reflog action. */
export function planUndo(reflog: ReflogEntry[]): Step | undefined {
  const [top] = reflog;
  if (!top || reflog.length < 2) return undefined;

  const checkout = /^checkout: moving from (\S+) to (\S+)$/.exec(top.subject);
  if (checkout) {
    return { kind: 'switch', branch: checkout[1], label: `switch back to ${checkout[1]}` };
  }

  if (/^rebase/.test(top.subject)) {
    // A finished rebase leaves a run of entries; the state to restore is the one before "(start)".
    const start = reflog.findIndex((e) => /^rebase[^:]*\(start\)/.test(e.subject));
    const before = start >= 0 ? reflog[start + 1] : reflog[1];
    if (!before) return undefined;
    return { kind: 'reset', sha: before.sha, label: `reset to ${before.sha.slice(0, 7)} (before the rebase)` };
  }

  const before = reflog[1];
  return { kind: 'reset', sha: before.sha, label: `reset to ${before.sha.slice(0, 7)} (undo "${top.subject}")` };
}

export function registerUndoCommands(context: vscode.ExtensionContext, { repos }: Deps): void {
  const redoStack = new Map<string, Step[]>();

  /** Stashes dirty changes if the user agrees; returns false to abort. */
  const ensureClean = async (repo: GitRepository, what: string): Promise<boolean> => {
    await repo.refresh();
    const dirty = repo.status.files.filter((f) => f.kind !== 'untracked');
    if (dirty.length === 0) return true;
    const choice = await vscode.window.showWarningMessage(
      `You have ${dirty.length} uncommitted change(s). ${what} would overwrite them.`,
      { modal: true },
      'Stash and Continue',
    );
    if (choice !== 'Stash and Continue') return false;
    await repo.stashPush({ message: `sourcestudio: before ${what.toLowerCase()}`, includeUntracked: true });
    return true;
  };

  const apply = async (repo: GitRepository, step: Step): Promise<void> => {
    if (step.kind === 'switch') await repo.checkout(step.branch);
    else await repo.reset(step.sha, 'hard');
    await repo.refresh();
  };

  /** Captures how to get back to the *current* state, for redo. */
  const inverseOfCurrent = (repo: GitRepository, step: Step): Step =>
    step.kind === 'switch'
      ? { kind: 'switch', branch: repo.status.head, label: `switch back to ${repo.status.head}` }
      : { kind: 'reset', sha: repo.status.oid, label: `reset to ${repo.status.oid.slice(0, 7)}` };

  registerSafe(context, 'sourcestudio.undo', async () => {
    const repo = requireActive(repos);
    if (!repo) return;
    if (repo.operation) {
      void vscode.window.showWarningMessage(`A ${repo.operation} is in progress — abort it instead of undoing.`);
      return;
    }
    const step = planUndo(await repo.reflog(50));
    if (!step) {
      void vscode.window.showInformationMessage('Nothing to undo.');
      return;
    }
    if (!(await confirm(`Undo: ${step.label}?`, 'Undo'))) return;
    if (step.kind === 'reset' && !(await ensureClean(repo, 'Undo'))) return;

    const redo = inverseOfCurrent(repo, step);
    await apply(repo, step);
    redoStack.set(repo.root, [...(redoStack.get(repo.root) ?? []), redo]);
    vscode.window.setStatusBarMessage(`$(discard) Undid — ${step.label}`, 4000);
  });

  registerSafe(context, 'sourcestudio.redo', async () => {
    const repo = requireActive(repos);
    if (!repo) return;
    const stack = redoStack.get(repo.root) ?? [];
    const step = stack[stack.length - 1];
    if (!step) {
      void vscode.window.showInformationMessage('Nothing to redo.');
      return;
    }
    // Redo only makes sense if nothing else happened since the undo.
    const [top] = await repo.reflog(1);
    const sinceUndo = top && !/^(reset: moving to [0-9a-f]{40}|checkout: moving from)/.test(top.subject);
    if (sinceUndo) {
      redoStack.delete(repo.root);
      void vscode.window.showInformationMessage('Nothing to redo — the repository changed since the last undo.');
      return;
    }
    if (!(await confirm(`Redo: ${step.label}?`, 'Redo'))) return;
    if (step.kind === 'reset' && !(await ensureClean(repo, 'Redo'))) return;
    await apply(repo, step);
    stack.pop();
    vscode.window.setStatusBarMessage(`$(redo) Redid — ${step.label}`, 4000);
  });

  registerSafe(context, 'sourcestudio.showReflog', async () => {
    const repo = requireActive(repos);
    if (!repo) return;
    const entries = await repo.reflog(100);
    const picked = await vscode.window.showQuickPick(
      entries.map((e) => ({
        label: `${e.index === 0 ? '$(circle-filled) ' : ''}${e.subject}`,
        description: `${e.sha.slice(0, 7)} · ${relativeAge(e.date)}`,
        detail: e.index === 0 ? 'Current state' : `HEAD@{${e.index}} — select to hard-reset to this state`,
        entry: e,
      })),
      { placeHolder: `Reflog for ${repo.name} — pick a state to reset to`, matchOnDescription: true },
    );
    if (!picked || picked.entry.index === 0) return;
    const { entry } = picked;
    if (!(await confirm(`Hard reset ${repo.status.head} to ${entry.sha.slice(0, 7)} "${entry.subject}"?`, 'Reset'))) return;
    if (!(await ensureClean(repo, 'Reset'))) return;
    const redo: Step = { kind: 'reset', sha: repo.status.oid, label: `reset to ${repo.status.oid.slice(0, 7)}` };
    await apply(repo, { kind: 'reset', sha: entry.sha, label: '' });
    redoStack.set(repo.root, [...(redoStack.get(repo.root) ?? []), redo]);
  });
}
