import { spawn } from 'node:child_process';
import * as vscode from 'vscode';

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(stderr.trim() || `git ${args.join(' ')} exited with code ${exitCode}`);
    this.name = 'GitError';
  }
}

export interface ExecOptions {
  cwd: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

function gitPath(): string {
  return vscode.workspace.getConfiguration('sourcestudio').get<string>('gitPath', 'git');
}

/**
 * Runs git and resolves with stdout. Rejects with GitError on a non-zero exit.
 * Output is always UTF-8; LANG is forced to C so messages are stable to parse.
 */
export function execGit(args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitPath(), args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        LANG: 'C',
        LC_ALL: 'C',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        // Never block on an editor: merge/rebase commit messages take git's default.
        GIT_EDITOR: 'true',
        ...opts.env,
      },
      windowsHide: true,
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new GitError(args, stderr, code));
      }
    });

    if (opts.stdin !== undefined) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
  });
}
