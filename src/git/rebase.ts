import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitRepository } from './repository';

/**
 * Non-interactive "interactive" rebase. We write the todo list git would normally
 * open in an editor, then point GIT_SEQUENCE_EDITOR at a script that copies our
 * file over git's. Same trick for GIT_EDITOR when a reword needs a new message.
 */

export type TodoAction = 'pick' | 'squash' | 'fixup' | 'reword' | 'drop' | 'edit';

export interface TodoLine {
  action: TodoAction;
  sha: string;
  subject: string;
}

let helperScript: string | undefined;

/** Writes the copy-helper script once per extension install. Call during activation. */
export async function prepareRebaseHelper(context: vscode.ExtensionContext): Promise<void> {
  const dir = context.globalStorageUri.fsPath;
  await fs.mkdir(dir, { recursive: true });
  helperScript = path.join(dir, 'copy-file.js');
  await fs.writeFile(
    helperScript,
    "// Used as GIT_SEQUENCE_EDITOR / GIT_EDITOR: copy-file.js <source> <git's-file>\n" +
      "const fs = require('fs'); const [src, dst] = process.argv.slice(2); fs.copyFileSync(src, dst);\n",
  );
}

/** Builds the environment that makes git use `todoFile` (and optionally `messageFile`) instead of an editor. */
async function editorEnv(todoFile: string, messageFile?: string): Promise<NodeJS.ProcessEnv> {
  if (!helperScript) throw new Error('Rebase helper not initialised');
  const q = (s: string) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
  const run = (file: string) => `${q(process.execPath)} ${q(helperScript!)} ${q(file)}`;
  return {
    ELECTRON_RUN_AS_NODE: '1', // process.execPath is Code's electron binary; this makes it behave as node
    GIT_SEQUENCE_EDITOR: run(todoFile),
    ...(messageFile ? { GIT_EDITOR: run(messageFile) } : {}),
  };
}

/** The linear commits from `base` (exclusive) to HEAD, oldest first, as pick lines. Throws on merges. */
export async function todoFor(repo: GitRepository, base: string): Promise<TodoLine[]> {
  const commits = await repo.revList(base, 'HEAD');
  if (commits.some((c) => c.parents.length > 1)) {
    throw new Error('That range contains a merge commit; an interactive rebase would flatten it. Use the terminal for this one.');
  }
  return commits.map((c) => ({ action: 'pick', sha: c.sha, subject: c.subject }));
}

export function renderTodo(lines: TodoLine[]): string {
  return lines.map((l) => `${l.action} ${l.sha} ${l.subject}`).join('\n') + '\n';
}

/** Runs `git rebase -i --autostash base` with the given todo, and an optional commit message for reword/squash. */
export async function runTodo(repo: GitRepository, base: string, lines: TodoLine[], message?: string): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sourcestudio-rebase-'));
  const todoFile = path.join(tmp, 'todo');
  const messageFile = message !== undefined ? path.join(tmp, 'message') : undefined;
  try {
    await fs.writeFile(todoFile, renderTodo(lines));
    if (messageFile) await fs.writeFile(messageFile, message!.endsWith('\n') ? message! : message + '\n');
    const env = await editorEnv(todoFile, messageFile);
    await repo.rebaseInteractive(base, env);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Replaces the subject line of a full commit message, keeping the body. */
export function replaceSubject(fullMessage: string, subject: string): string {
  const [, ...rest] = fullMessage.split('\n');
  const body = rest.join('\n').replace(/^\n+/, '');
  return body.trim() ? `${subject}\n\n${body}` : subject;
}
