import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isTextConflict, resolveWithSide } from '../diff/mergeEditor';
import { GitRepository } from '../git/repository';
import { FileStatus } from '../git/types';
import { RepoManager } from '../model/repoManager';
import { FileNode, FilesView, filesUnder } from '../views/filesView';
import { confirm, registerSafe } from './util';

interface Deps {
  repos: RepoManager;
  filesView: FilesView;
}

export function registerConflictCommands(context: vscode.ExtensionContext, { repos, filesView }: Deps): void {
  /** Conflicted files under the given nodes (or the Files selection), grouped by repository. */
  const conflictedFiles = (node?: FileNode, nodes?: FileNode[]): Map<GitRepository, FileStatus[]> => {
    const sel = nodes?.length ? nodes : node ? [node] : [...filesView.selection];
    const byRepo = new Map<GitRepository, FileStatus[]>();
    for (const n of sel) {
      if (n.area !== 'conflicted') continue;
      byRepo.set(n.repo, [...(byRepo.get(n.repo) ?? []), ...filesUnder(n)]);
    }
    return byRepo;
  };

  /** Merge editor title bar (passes the result file's Uri), or the palette while a merge editor is active. */
  const markResolvedInMergeEditor = async (uri: vscode.Uri): Promise<void> => {
    const repo = repos.repositoryFor(uri.fsPath);
    if (!repo) return;
    // Asks about unhandled conflicts, writes the result and closes the editor.
    const result = await vscode.commands.executeCommand<{ successful?: boolean } | undefined>('mergeEditor.acceptMerge');
    if (!result?.successful) return;
    await saveIfDirty(uri);
    await repo.stage([path.relative(repo.root, uri.fsPath).split(path.sep).join('/')]);
    await repo.refresh();
  };

  registerSafe(context, 'sourcestudio.markResolved', async (arg?: FileNode | vscode.Uri, nodes?: FileNode[]) => {
    const editorUri = arg instanceof vscode.Uri ? arg : arg ? undefined : activeMergeResult();
    if (editorUri) return markResolvedInMergeEditor(editorUri);

    for (const [repo, files] of conflictedFiles(arg as FileNode | undefined, nodes)) {
      const withMarkers: string[] = [];
      for (const f of files.filter(isTextConflict)) {
        const uri = repo.fileUri(f.path);
        await saveIfDirty(uri);
        const text = await fs.readFile(uri.fsPath, 'utf8').catch(() => '');
        if (hasConflictMarkers(text)) withMarkers.push(f.path);
      }
      if (withMarkers.length) {
        const what = withMarkers.length === 1 ? withMarkers[0] : `${withMarkers.length} files`;
        if (!(await confirm(`${what} still has conflict markers. Mark resolved anyway?`, 'Mark Resolved'))) return;
      }
      await repo.stage(files.map((f) => f.path));
      await repo.refresh();
    }
  });

  const accept = (side: 'ours' | 'theirs', label: string) => async (node?: FileNode, nodes?: FileNode[]) => {
    for (const [repo, files] of conflictedFiles(node, nodes)) {
      const what = files.length === 1 ? files[0].path : `${files.length} files`;
      const other = side === 'ours' ? 'Incoming' : 'Current';
      if (!(await confirm(`Resolve ${what} by taking the ${label} side? ${other} changes and any edits you've made to these files are discarded.`, `Accept ${label}`))) return;
      await resolveWithSide(repo, files, side);
      await repo.refresh();
    }
  };
  registerSafe(context, 'sourcestudio.acceptCurrent', accept('ours', 'Current'));
  registerSafe(context, 'sourcestudio.acceptIncoming', accept('theirs', 'Incoming'));
}

/**
 * The result file of the active merge editor. Reads the tab input by shape because its type
 * (`TabInputTextMerge`) is still proposed API.
 */
function activeMergeResult(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { result?: unknown } | undefined;
  return input?.result instanceof vscode.Uri ? input.result : undefined;
}

async function saveIfDirty(uri: vscode.Uri): Promise<void> {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath && d.isDirty);
  await doc?.save();
}

/** True when `text` still contains git conflict markers left from a merge. */
export function hasConflictMarkers(text: string): boolean {
  // TODO(human): detect leftover conflict markers in `text`.
  return false;
}
