import * as vscode from 'vscode';
import { relativeAge } from '../commands/util';
import { GitRepository } from '../git/repository';
import { Stash } from '../git/types';
import { RepoManager } from '../model/repoManager';

export interface StashNode {
  stash: Stash;
  repo: GitRepository;
}

export class StashesView implements vscode.TreeDataProvider<StashNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<StashNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  readonly treeView: vscode.TreeView<StashNode>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly repos: RepoManager) {
    this.treeView = vscode.window.createTreeView('sourcestudio.stashes', { treeDataProvider: this });
    this.disposables.push(
      this.treeView,
      repos.onDidChangeActive(() => this.refresh()),
      repos.onDidChangeStatus((r) => {
        if (r === repos.active) this.refresh();
      }),
    );
    this.refresh();
  }

  get selected(): StashNode | undefined {
    return this.treeView.selection[0];
  }

  private refresh(): void {
    const repo = this.repos.active;
    this.treeView.title = repo ? `Stashes — ${repo.name}` : 'Stashes';
    this.treeView.message = repo && repo.stashes.length === 0 ? 'No stashes' : undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  getChildren(): StashNode[] {
    const repo = this.repos.active;
    return repo ? repo.stashes.map((stash) => ({ stash, repo })) : [];
  }

  getTreeItem({ stash, repo }: StashNode): vscode.TreeItem {
    const item = new vscode.TreeItem(stash.message || '(no message)', vscode.TreeItemCollapsibleState.None);
    item.id = `${repo.root}|stash|${stash.index}`;
    item.description = `${stash.ref}  ${relativeAge(stash.date)}`;
    item.iconPath = new vscode.ThemeIcon('archive');
    item.contextValue = 'stash';
    item.command = { command: 'sourcestudio.showStash', title: 'Show Stash', arguments: [{ stash, repo }] };
    return item;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onDidChangeTreeData.dispose();
  }
}
