import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { execGit } from './exec';

async function isRepoRoot(dir: string): Promise<boolean> {
  try {
    // `.git` is a directory for normal repos and a file for worktrees/submodules.
    await fs.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function walk(dir: string, depth: number, ignored: Set<string>, found: Set<string>): Promise<void> {
  if (await isRepoRoot(dir)) {
    found.add(dir);
    return; // don't descend into a repo looking for nested ones (submodules come later)
  }
  if (depth <= 0) return;

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !ignored.has(e.name) && !e.name.startsWith('.'))
      .map((e) => walk(path.join(dir, e.name), depth - 1, ignored, found)),
  );
}

/**
 * Finds git repositories in the workspace: each workspace folder that is a repo,
 * the enclosing repo if a folder is opened from inside one, and repos in subfolders
 * up to `sourcestudio.scanDepth` levels deep.
 */
export async function discoverRepositories(): Promise<string[]> {
  const config = vscode.workspace.getConfiguration('sourcestudio');
  const depth = config.get<number>('scanDepth', 3);
  const ignored = new Set(config.get<string[]>('ignoredFolders', []));
  const found = new Set<string>();

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const dir = folder.uri.fsPath;
    await walk(dir, depth, ignored, found);

    if (!(await isRepoRoot(dir))) {
      // Folder may live inside a repo (e.g. opened `repo/packages/web`).
      try {
        const { stdout } = await execGit(['rev-parse', '--show-toplevel'], { cwd: dir });
        const top = stdout.trim();
        if (top) found.add(path.normalize(top));
      } catch {
        /* not inside a repo */
      }
    }
  }

  return [...found].sort((a, b) => a.localeCompare(b));
}
