import * as vscode from 'vscode';
import { GitRepository } from '../git/repository';
import { RepoManager } from '../model/repoManager';

export type CommandHandler = (...args: any[]) => unknown;

/** Registers a command whose errors are shown as notifications instead of crashing the handler. */
export function registerSafe(context: vscode.ExtensionContext, id: string, fn: CommandHandler): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (e) {
        reportError(e);
      }
    }),
  );
}

export function requireActive(repos: RepoManager): GitRepository | undefined {
  const repo = repos.active;
  if (!repo) void vscode.window.showWarningMessage('Source Studio: no active repository.');
  return repo;
}

export function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
}

export function reportError(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  void vscode.window.showErrorMessage(`Source Studio: ${msg}`);
  console.error('[sourcestudio]', e);
}

export async function confirm(message: string, action: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
}

/** "3h", "2d", "5w" style age for a unix timestamp. */
export function relativeAge(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 9) return `${w}w`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

/** Runs a git operation that may stop on conflicts (rebase, merge, cherry-pick, revert) and explains what happened. */
export async function runOperation(repo: GitRepository, title: string, fn: () => Promise<void>): Promise<void> {
  try {
    await withProgress(title, fn);
  } catch (e) {
    await repo.refresh();
    if (repo.operation) {
      void vscode.window.showWarningMessage(
        `${title} stopped on conflicts. Resolve them in the Files view, then Continue (or Abort).`,
      );
      return;
    }
    throw e;
  }
  await repo.refresh();
}
