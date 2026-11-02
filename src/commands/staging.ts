import * as path from 'node:path';
import * as vscode from 'vscode';
import { GIT_SCHEME, parseGitUri } from '../diff/gitContentProvider';
import { buildPatch, parseDiff } from '../git/patch';
import { GitRepository } from '../git/repository';
import { RepoManager } from '../model/repoManager';
import { confirm, registerSafe } from './util';

interface Deps {
  repos: RepoManager;
}

type Mode = 'stage' | 'unstage' | 'discard';

/**
 * Line/hunk staging from a diff editor. The active editor tells us which side we're on:
 *  - a `file:` document → its lines are worktree lines → stage / discard against the index diff
 *  - a `sourcestudio-git:` document at `:0` → its lines are index lines → unstage against the cached diff
 */
export function registerStagingCommands(context: vscode.ExtensionContext, { repos }: Deps): void {
  const resolveTarget = (mode: Mode): { repo: GitRepository; relPath: string; editor: vscode.TextEditor } | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const uri = editor.document.uri;

    if (mode === 'unstage') {
      if (uri.scheme !== GIT_SCHEME) {
        void vscode.window.showInformationMessage('Unstage lines from the "HEAD ↔ Index" diff (open a file under Staged Changes).');
        return undefined;
      }
      const { repo: root, ref, relPath } = parseGitUri(uri);
      if (ref !== ':0') {
        void vscode.window.showInformationMessage('Select lines on the right (index) side of the staged diff.');
        return undefined;
      }
      const repo = repos.repositories.find((r) => r.root === root);
      return repo ? { repo, relPath, editor } : undefined;
    }

    if (uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Select lines in the working-tree side of the diff.');
      return undefined;
    }
    const repo = repos.repositoryFor(uri.fsPath);
    if (!repo) return undefined;
    const relPath = path.relative(repo.root, uri.fsPath).split(path.sep).join('/');
    return { repo, relPath, editor };
  };

  const run = async (mode: Mode, wholeHunks: boolean): Promise<void> => {
    const t = resolveTarget(mode);
    if (!t) return;
    const { repo, relPath, editor } = t;

    if (editor.document.isDirty) await editor.document.save();

    // Union of all selections, as 1-based inclusive line ranges.
    const ranges = editor.selections.map((s) => {
      const endLine = s.end.character === 0 && !s.end.isEqual(s.start) ? s.end.line - 1 : s.end.line;
      return [s.start.line + 1, Math.max(s.start.line, endLine) + 1] as const;
    });

    const diff = parseDiff(await repo.diffFile(relPath, mode === 'unstage'));
    if (diff.hunks.length === 0) {
      void vscode.window.showInformationMessage('No changes to work with in this file.');
      return;
    }
    const patches = ranges.map(([a, b]) => buildPatch(diff, a, b, wholeHunks)).filter((p): p is string => !!p);
    if (patches.length === 0) {
      void vscode.window.showInformationMessage(`No ${mode === 'unstage' ? 'staged ' : ''}changes in the selection.`);
      return;
    }

    if (mode === 'discard') {
      const what = wholeHunks ? 'this hunk' : 'the selected lines';
      if (!(await confirm(`Discard ${what} in ${relPath}? This cannot be undone.`, 'Discard'))) return;
    }

    for (const patch of patches) {
      await repo.applyPatch(patch, { cached: mode !== 'discard', reverse: mode !== 'stage' });
    }
    await repo.refresh();
  };

  registerSafe(context, 'sourcestudio.stageSelection', () => run('stage', false));
  registerSafe(context, 'sourcestudio.stageHunk', () => run('stage', true));
  registerSafe(context, 'sourcestudio.unstageSelection', () => run('unstage', false));
  registerSafe(context, 'sourcestudio.unstageHunk', () => run('unstage', true));
  registerSafe(context, 'sourcestudio.discardSelection', () => run('discard', false));
  registerSafe(context, 'sourcestudio.discardHunk', () => run('discard', true));
}
