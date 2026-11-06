import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitRepository } from '../git/repository';
import { FileStatus, Operation } from '../git/types';
import { gitUri } from './gitContentProvider';

/**
 * Which sides of a conflict still have the file, by porcelain XY code.
 * Current is stage 2 (`--ours`), Incoming is stage 3 (`--theirs`).
 */
const SIDES: Record<string, { current: boolean; incoming: boolean; what: string }> = {
  UU: { current: true, incoming: true, what: 'Changed on both sides' },
  AA: { current: true, incoming: true, what: 'Added on both sides' },
  UD: { current: true, incoming: false, what: 'Changed in Current, deleted in Incoming' },
  DU: { current: false, incoming: true, what: 'Deleted in Current, changed in Incoming' },
  AU: { current: true, incoming: false, what: 'Added only in Current' },
  UA: { current: false, incoming: true, what: 'Added only in Incoming' },
  DD: { current: false, incoming: false, what: 'Deleted on both sides' },
};

export function conflictSides(f: FileStatus): { current: boolean; incoming: boolean; what: string } {
  return SIDES[f.index + f.worktree] ?? SIDES.UU;
}

/** Text conflicts can be merged line by line; the rest (one side deleted the file) can only be kept or deleted. */
export function isTextConflict(f: FileStatus): boolean {
  const s = conflictSides(f);
  return s.current && s.incoming;
}

/** The ref git leaves pointing at the incoming commit while an operation is paused. */
const INCOMING_REF: Record<Operation, string> = {
  merge: 'MERGE_HEAD',
  rebase: 'REBASE_HEAD',
  'cherry-pick': 'CHERRY_PICK_HEAD',
  revert: 'REVERT_HEAD',
};

/**
 * Opens a text conflict in VS Code's 3-way merge editor. `_open.mergeEditor` is the internal
 * command the built-in Git extension uses; it isn't public API, so it may change between releases.
 */
export async function openMergeEditor(repo: GitRepository, file: FileStatus): Promise<void> {
  const op = repo.operation;
  const [headDetail, incomingDetail] = await Promise.all([
    repo.describe('HEAD'),
    op ? repo.describe(INCOMING_REF[op]) : Promise.resolve(undefined),
  ]);
  const branch = repo.status.head === '(detached)' ? undefined : repo.status.head;
  const current = { uri: gitUri(repo.root, file.path, ':2'), title: 'Current', description: branch, detail: headDetail };
  const incoming = { uri: gitUri(repo.root, file.path, ':3'), title: 'Incoming', description: op, detail: incomingDetail };

  // Same order as the built-in Git extension: during a rebase the branch being rebased onto goes first.
  await vscode.commands.executeCommand('_open.mergeEditor', {
    base: gitUri(repo.root, file.path, ':1'),
    input1: op === 'rebase' ? current : incoming,
    input2: op === 'rebase' ? incoming : current,
    output: repo.fileUri(file.path),
  });
}

/** Resolves conflicted files by taking one side wholesale; a side that deleted the file resolves as a delete. */
export async function resolveWithSide(repo: GitRepository, files: FileStatus[], side: 'ours' | 'theirs'): Promise<void> {
  const has = (f: FileStatus) => (side === 'ours' ? conflictSides(f).current : conflictSides(f).incoming);
  const keep = files.filter(has).map((f) => f.path);
  const drop = files.filter((f) => !has(f)).map((f) => f.path);
  await repo.checkoutSide(keep, side);
  await repo.stage(keep);
  await repo.remove(drop);
}

/** Opens a conflicted file: the merge editor for text conflicts, a keep/delete choice otherwise. */
export async function openConflict(repo: GitRepository, file: FileStatus): Promise<void> {
  if (isTextConflict(file)) {
    await openMergeEditor(repo, file);
    return;
  }
  const s = conflictSides(file);
  type Item = vscode.QuickPickItem & { side: 'ours' | 'theirs' };
  const items: Item[] = [
    { label: s.current ? 'Keep Current version' : 'Delete the file (as in Current)', side: 'ours' },
    { label: s.incoming ? 'Keep Incoming version' : 'Delete the file (as in Incoming)', side: 'theirs' },
  ];
  const picked = await vscode.window.showQuickPick(s.current || s.incoming ? items : [{ ...items[0], label: 'Delete the file' }], {
    title: `${path.posix.basename(file.path)}: ${s.what}`,
    placeHolder: 'How should this conflict be resolved?',
  });
  if (!picked) return;
  await resolveWithSide(repo, [file], picked.side);
  await repo.refresh();
}
