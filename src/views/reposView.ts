import * as vscode from 'vscode';
import { GitRepository } from '../git/repository';
import { areasOf } from '../git/types';
import { RepoManager } from '../model/repoManager';

/** One-line summary used in the Repos view and the status bar: `main ↑2 ↓1 ●5`. */
export function repoSummary(repo: GitRepository): string {
  const s = repo.status;
  const parts = [s.head];
  if (s.ahead) parts.push(`↑${s.ahead}`);
  if (s.behind) parts.push(`↓${s.behind}`);
  const changed = s.files.length;
  if (changed) parts.push(`●${changed}`);
  const conflicts = s.files.filter((f) => f.kind === 'unmerged').length;
  if (conflicts) parts.push(`!${conflicts}`);
  return parts.join(' ');
}

export class ReposView implements vscode.TreeDataProvider<GitRepository>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<GitRepository | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  readonly treeView: vscode.TreeView<GitRepository>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly repos: RepoManager) {
    this.treeView = vscode.window.createTreeView('sourcestudio.repos', { treeDataProvider: this, showCollapseAll: false });
    this.disposables.push(
      this.treeView,
      repos.onDidChangeRepositories(() => this._onDidChangeTreeData.fire(undefined)),
      repos.onDidChangeActive(() => this._onDidChangeTreeData.fire(undefined)),
      repos.onDidChangeStatus((r) => this._onDidChangeTreeData.fire(r)),
    );
  }

  getTreeItem(repo: GitRepository): vscode.TreeItem {
    const active = repo === this.repos.active;
    const item = new vscode.TreeItem(repo.name, vscode.TreeItemCollapsibleState.None);
    item.id = repo.root;
    item.description = repoSummary(repo);
    item.tooltip = new vscode.MarkdownString(
      `**${repo.name}**  \n${repo.root}  \n\n` +
        `Branch: \`${repo.status.head}\`` +
        (repo.status.upstream ? ` → \`${repo.status.upstream}\`` : '') +
        `  \nStaged: ${count(repo, 'staged')} · Unstaged: ${count(repo, 'unstaged')} · Untracked: ${count(repo, 'untracked')}`,
    );
    item.iconPath = new vscode.ThemeIcon(
      'repo',
      active ? new vscode.ThemeColor('charts.green') : new vscode.ThemeColor('descriptionForeground'),
    );
    item.contextValue = active ? 'repo:active' : 'repo';
    item.command = { command: 'sourcestudio.setActiveRepo', title: 'Set Active Repository', arguments: [repo] };
    return item;
  }

  getChildren(): GitRepository[] {
    return [...this.repos.repositories];
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onDidChangeTreeData.dispose();
  }
}

function count(repo: GitRepository, area: 'staged' | 'unstaged' | 'untracked'): number {
  return repo.status.files.filter((f) => areasOf(f).includes(area)).length;
}
