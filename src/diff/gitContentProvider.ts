import * as vscode from 'vscode';
import { RepoManager } from '../model/repoManager';

export const GIT_SCHEME = 'sourcestudio-git';

interface GitUriQuery {
  repo: string;
  ref: string;
}

/**
 * Builds a `sourcestudio-git:` URI for `relPath` at `ref` in `repo`.
 * `ref` of '' yields an empty document (used for the "before" side of added files).
 */
export function gitUri(repoRoot: string, relPath: string, ref: string): vscode.Uri {
  const q: GitUriQuery = { repo: repoRoot, ref };
  return vscode.Uri.from({ scheme: GIT_SCHEME, path: '/' + relPath, query: JSON.stringify(q) });
}

export function parseGitUri(uri: vscode.Uri): { relPath: string } & GitUriQuery {
  const q = JSON.parse(uri.query) as GitUriQuery;
  return { relPath: uri.path.replace(/^\//, ''), ...q };
}

export class GitContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private readonly open = new Map<string, vscode.Uri>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly repos: RepoManager) {
    this.disposables.push(
      // When a repo's status changes, every open git: document in it may be stale.
      repos.onDidChangeStatus((repo) => {
        for (const uri of this.open.values()) {
          if (parseGitUri(uri).repo === repo.root) this._onDidChange.fire(uri);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme === GIT_SCHEME) this.open.delete(doc.uri.toString());
      }),
    );
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    this.open.set(uri.toString(), uri);
    const { repo, ref, relPath } = parseGitUri(uri);
    const repository = this.repos.repositories.find((r) => r.root === repo);
    if (!repository) return '';
    return repository.show(ref, relPath);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onDidChange.dispose();
  }
}
