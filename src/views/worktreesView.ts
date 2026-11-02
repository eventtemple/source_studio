import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitRepository } from '../git/repository';
import { Worktree } from '../git/types';
import { RepoManager } from '../model/repoManager';

export interface WorktreeNode {
  worktree: Worktree;
  repo: GitRepository;
}

export class WorktreesView implements vscode.TreeDataProvider<WorktreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<WorktreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  readonly treeView: vscode.TreeView<WorktreeNode>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly repos: RepoManager) {
    this.treeView = vscode.window.createTreeView('sourcestudio.worktrees', { treeDataProvider: this });
    this.disposables.push(
      this.treeView,
      repos.onDidChangeActive(() => this.refresh()),
      repos.onDidChangeStatus((r) => {
        if (r === repos.active) this.refresh();
      }),
    );
    this.refresh();
  }

  get selected(): WorktreeNode | undefined {
    return this.treeView.selection[0];
  }

  private refresh(): void {
    const repo = this.repos.active;
    this.treeView.title = repo ? `Worktrees — ${repo.name}` : 'Worktrees';
    this._onDidChangeTreeData.fire(undefined);
  }

  getChildren(): WorktreeNode[] {
    const repo = this.repos.active;
    return repo ? repo.worktrees.map((worktree) => ({ worktree, repo })) : [];
  }

  getTreeItem({ worktree, repo }: WorktreeNode): vscode.TreeItem {
    const isThis = path.normalize(worktree.path) === repo.root;
    const label = worktree.bare ? '(bare)' : worktree.detached ? `(detached ${worktree.head.slice(0, 7)})` : worktree.branch ?? '?';
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `${repo.root}|worktree|${worktree.path}`;

    const parts = [path.basename(worktree.path)];
    if (worktree.main) parts.push('main');
    if (worktree.locked) parts.push('🔒');
    if (worktree.prunable) parts.push('prunable');
    item.description = parts.join(' · ');

    item.tooltip = new vscode.MarkdownString(
      `${worktree.path}  \n\`${worktree.head.slice(0, 7)}\`` +
        (worktree.locked ? `  \nLocked: ${worktree.locked}` : '') +
        (worktree.prunable ? `  \nPrunable: ${worktree.prunable}` : ''),
    );
    item.iconPath = isThis
      ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon(worktree.main ? 'home' : 'folder-library');
    item.contextValue = isThis ? 'worktree:current' : worktree.main ? 'worktree:main' : 'worktree:linked';
    return item;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onDidChangeTreeData.dispose();
  }
}
