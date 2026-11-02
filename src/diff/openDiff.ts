import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitRepository } from '../git/repository';
import { Area, ChangedFile, FileStatus } from '../git/types';
import { gitUri } from './gitContentProvider';

interface DiffSides {
  left: vscode.Uri;
  right: vscode.Uri;
  label: string;
}

/** Works out the before/after URIs for a file in a given area. */
export function diffSides(repo: GitRepository, file: FileStatus, area: Area): DiffSides | undefined {
  const working = repo.fileUri(file.path);
  const index = gitUri(repo.root, file.path, ':0');
  const head = gitUri(repo.root, file.origPath ?? file.path, 'HEAD');
  const empty = (p: string) => gitUri(repo.root, p, '');

  switch (area) {
    case 'staged':
      return {
        left: file.index === 'A' ? empty(file.path) : head,
        right: file.index === 'D' ? empty(file.path) : index,
        label: 'HEAD ↔ Index',
      };
    case 'unstaged':
      return {
        left: index,
        right: file.worktree === 'D' ? empty(file.path) : working,
        label: 'Index ↔ Working Tree',
      };
    case 'untracked':
    case 'conflicted':
      return undefined; // open the file directly instead
  }
}

export async function openFileDiff(repo: GitRepository, file: FileStatus, area: Area, preview = true): Promise<void> {
  const sides = diffSides(repo, file, area);
  if (!sides) {
    await vscode.window.showTextDocument(repo.fileUri(file.path), { preview });
    return;
  }
  const title = `${path.basename(file.path)} (${sides.label})`;
  await vscode.commands.executeCommand('vscode.diff', sides.left, sides.right, title, { preview });
}

/** Opens every file in one multi-diff editor (VS Code 1.86+). */
export async function openMultiDiff(repo: GitRepository, files: FileStatus[], area: Area, title: string): Promise<void> {
  const resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = files.map((f) => {
    const sides = diffSides(repo, f, area);
    const working = repo.fileUri(f.path);
    return sides ? [working, sides.left, sides.right] : [working, undefined, working];
  });
  await vscode.commands.executeCommand('vscode.changes', title, resources);
}

/** Opens a multi-diff of everything that changed between `from` and `to` (commits, stashes). */
export async function openRefDiff(repo: GitRepository, from: string, to: string, title: string): Promise<void> {
  const files = await repo.changedFiles(from, to);
  const resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = files.map((f: ChangedFile) => {
    const label = repo.fileUri(f.path);
    const left = f.status === 'A' ? gitUri(repo.root, f.path, '') : gitUri(repo.root, f.origPath ?? f.path, from);
    const right = f.status === 'D' ? gitUri(repo.root, f.path, '') : gitUri(repo.root, f.path, to);
    return [label, left, right];
  });
  if (resources.length === 0) {
    void vscode.window.showInformationMessage(`${title}: no file changes.`);
    return;
  }
  await vscode.commands.executeCommand('vscode.changes', title, resources);
}
