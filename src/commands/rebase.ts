import * as vscode from 'vscode';
import { replaceSubject, runTodo, todoFor, TodoAction } from '../git/rebase';
import { GitRepository } from '../git/repository';
import { RepoManager } from '../model/repoManager';
import { CommitContext, CommitsView } from '../views/commitsView';
import { confirm, registerSafe, requireActive, runOperation } from './util';

interface Deps {
  repos: RepoManager;
  commitsView: CommitsView;
}

interface WebviewContext {
  webviewSection?: string;
  sha?: string;
}

export function registerRebaseCommands(context: vscode.ExtensionContext, { repos, commitsView }: Deps): void {
  const resolve = (arg?: CommitContext | WebviewContext) => {
    const ctx = arg && 'parents' in arg ? arg : arg?.sha ? commitsView.commit(arg.sha) : undefined;
    if (!ctx) return undefined;
    const repo = repos.repositories.find((r) => r.root === ctx.repoRoot);
    return repo ? { repo, ...ctx } : undefined;
  };

  const guard = (repo: GitRepository, t: { parents: string[] }): boolean => {
    if (repo.operation) {
      void vscode.window.showWarningMessage(`A ${repo.operation} is already in progress. Continue or abort it first.`);
      return false;
    }
    if (t.parents.length === 0) {
      void vscode.window.showWarningMessage('The root commit cannot be rebased.');
      return false;
    }
    if (t.parents.length > 1) {
      void vscode.window.showWarningMessage('Merge commits cannot be rewritten with an interactive rebase.');
      return false;
    }
    return true;
  };

  /** Rebases from `base`, applying `mutate` to the todo. */
  const rewrite = async (
    repo: GitRepository,
    base: string,
    title: string,
    mutate: (lines: import('../git/rebase').TodoLine[]) => void,
    message?: string,
  ) => {
    const lines = await todoFor(repo, base);
    mutate(lines);
    await runOperation(repo, title, () => runTodo(repo, base, lines, message));
  };

  const setAction = (action: TodoAction, sha: string) => (lines: import('../git/rebase').TodoLine[]) => {
    const line = lines.find((l) => l.sha === sha);
    if (!line) throw new Error(`Commit ${sha.slice(0, 7)} is not in the rebase range`);
    line.action = action;
  };

  // squash / fixup fold the commit into its parent, so the parent must be in the todo: base = sha~2
  registerSafe(context, 'sourcestudio.squashCommit', async (arg?: CommitContext | WebviewContext) => {
    const t = resolve(arg);
    if (!t || !guard(t.repo, t)) return;
    await rewrite(t.repo, `${t.sha}~2`, `Squashing ${t.sha.slice(0, 7)} into its parent`, setAction('squash', t.sha));
  });

  registerSafe(context, 'sourcestudio.fixupCommit', async (arg?: CommitContext | WebviewContext) => {
    const t = resolve(arg);
    if (!t || !guard(t.repo, t)) return;
    await rewrite(t.repo, `${t.sha}~2`, `Fixing up ${t.sha.slice(0, 7)} into its parent`, setAction('fixup', t.sha));
  });

  registerSafe(context, 'sourcestudio.rewordCommit', async (arg?: CommitContext | WebviewContext) => {
    const t = resolve(arg);
    if (!t || !guard(t.repo, t)) return;
    const current = await t.repo.fullMessage(t.sha);
    const subject = await vscode.window.showInputBox({
      prompt: `Reword ${t.sha.slice(0, 7)} (body is kept)`,
      value: current.split('\n')[0],
      ignoreFocusOut: true,
    });
    if (!subject?.trim()) return;
    const message = replaceSubject(current, subject.trim());
    if (t.sha === t.repo.status.oid) {
      await t.repo.amend(message); // HEAD: no rebase needed
      await t.repo.refresh();
      return;
    }
    await rewrite(t.repo, `${t.sha}~1`, `Rewording ${t.sha.slice(0, 7)}`, setAction('reword', t.sha), message);
  });

  registerSafe(context, 'sourcestudio.dropCommit', async (arg?: CommitContext | WebviewContext) => {
    const t = resolve(arg);
    if (!t || !guard(t.repo, t)) return;
    if (!(await confirm(`Drop ${t.sha.slice(0, 7)} "${t.subject}" from history?`, 'Drop'))) return;
    await rewrite(t.repo, `${t.sha}~1`, `Dropping ${t.sha.slice(0, 7)}`, setAction('drop', t.sha));
  });

  registerSafe(context, 'sourcestudio.editCommit', async (arg?: CommitContext | WebviewContext) => {
    const t = resolve(arg);
    if (!t || !guard(t.repo, t)) return;
    await rewrite(t.repo, `${t.sha}~1`, `Stopping at ${t.sha.slice(0, 7)}`, setAction('edit', t.sha));
    await t.repo.refresh();
    if (t.repo.operation === 'rebase') {
      void vscode.window.showInformationMessage(
        `Rebase paused at ${t.sha.slice(0, 7)}. Make changes, stage them, Amend (A), then Continue.`,
      );
    }
  });

  const move = (direction: 'older' | 'newer') => async (arg?: CommitContext | WebviewContext) => {
    const t = resolve(arg);
    if (!t || !guard(t.repo, t)) return;
    // Todo is oldest-first. Moving a commit "older" means swapping with the line before it.
    const base = direction === 'older' ? `${t.sha}~2` : `${t.sha}~1`;
    await rewrite(t.repo, base, `Moving ${t.sha.slice(0, 7)} ${direction === 'older' ? 'down' : 'up'}`, (lines) => {
      const i = lines.findIndex((l) => l.sha === t.sha);
      const j = direction === 'older' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= lines.length) throw new Error('Cannot move that commit any further');
      [lines[i], lines[j]] = [lines[j], lines[i]];
    });
  };
  registerSafe(context, 'sourcestudio.moveCommitDown', move('older'));
  registerSafe(context, 'sourcestudio.moveCommitUp', move('newer'));

  registerSafe(context, 'sourcestudio.amendCommit', async () => {
    const repo = requireActive(repos);
    if (!repo) return;
    await repo.refresh();
    const staged = repo.status.files.some((f) => f.index !== '.' && f.kind === 'tracked');
    if (!staged) {
      void vscode.window.showInformationMessage('Nothing staged to amend with.');
      return;
    }
    if (!(await confirm(`Amend ${repo.status.oid.slice(0, 7)} with the staged changes?`, 'Amend'))) return;
    await repo.amend();
    await repo.refresh();
  });
}
