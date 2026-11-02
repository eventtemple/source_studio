import * as vscode from 'vscode';
import { relativeAge } from '../commands/util';
import { GitRepository } from '../git/repository';
import { Branch } from '../git/types';
import { RepoManager } from '../model/repoManager';

export type BranchNode =
  | { type: 'group'; kind: 'local' | 'remotes'; repo: GitRepository }
  | { type: 'remote'; name: string; repo: GitRepository }
  | { type: 'branch'; branch: Branch; repo: GitRepository };

export class BranchesView implements vscode.TreeDataProvider<BranchNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<BranchNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  readonly treeView: vscode.TreeView<BranchNode>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly repos: RepoManager) {
    this.treeView = vscode.window.createTreeView('sourcestudio.branches', { treeDataProvider: this, showCollapseAll: true });
    this.disposables.push(
      this.treeView,
      repos.onDidChangeActive(() => this.refresh()),
      repos.onDidChangeStatus((r) => {
        if (r === repos.active) this.refresh();
      }),
    );
    this.refresh();
  }

  /** The selected branch node, if any — used by keyboard-driven commands. */
  get selectedBranch(): Extract<BranchNode, { type: 'branch' }> | undefined {
    const [node] = this.treeView.selection;
    return node?.type === 'branch' ? node : undefined;
  }

  private refresh(): void {
    const repo = this.repos.active;
    this.treeView.title = repo ? `Branches — ${repo.name}` : 'Branches';
    this.treeView.message = repo?.operation ? `${capitalize(repo.operation)} in progress — resolve conflicts, then Continue or Abort.` : undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  getChildren(node?: BranchNode): BranchNode[] {
    const repo = this.repos.active;
    if (!repo) return [];
    if (!node) {
      const groups: BranchNode[] = [{ type: 'group', kind: 'local', repo }];
      if (repo.branches.some((b) => b.remote)) groups.push({ type: 'group', kind: 'remotes', repo });
      return groups;
    }
    switch (node.type) {
      case 'group':
        if (node.kind === 'local') {
          // for-each-ref already sorts by committer date; pin the current branch on top.
          const local = repo.branches.filter((b) => !b.remote);
          return [...local.filter((b) => b.current), ...local.filter((b) => !b.current)].map((branch) => ({
            type: 'branch',
            branch,
            repo,
          }));
        }
        return [...new Set(repo.branches.flatMap((b) => (b.remote ? [b.remote] : [])))].map((name) => ({
          type: 'remote',
          name,
          repo,
        }));
      case 'remote':
        return repo.branches.filter((b) => b.remote === node.name).map((branch) => ({ type: 'branch', branch, repo }));
      case 'branch':
        return [];
    }
  }

  getTreeItem(node: BranchNode): vscode.TreeItem {
    switch (node.type) {
      case 'group': {
        const label = node.kind === 'local' ? 'Local' : 'Remotes';
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `${node.repo.root}|branches|${node.kind}`;
        item.contextValue = `branchGroup:${node.kind}`;
        return item;
      }
      case 'remote': {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `${node.repo.root}|remote|${node.name}`;
        item.iconPath = new vscode.ThemeIcon('cloud');
        item.contextValue = 'remote';
        return item;
      }
      case 'branch':
        return branchItem(node);
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onDidChangeTreeData.dispose();
  }
}

function branchItem(node: Extract<BranchNode, { type: 'branch' }>): vscode.TreeItem {
  const b = node.branch;
  const label = b.remote ? b.name.slice(b.remote.length + 1) : b.name;
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.id = `${node.repo.root}|branch|${b.fullRef}`;

  const parts: string[] = [];
  if (b.ahead) parts.push(`↑${b.ahead}`);
  if (b.behind) parts.push(`↓${b.behind}`);
  if (b.upstreamGone) parts.push('⚠ gone');
  parts.push(relativeAge(b.date));
  item.description = parts.join(' ');

  item.iconPath = b.current
    ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
    : new vscode.ThemeIcon(b.remote ? 'cloud' : 'git-branch');

  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${b.name}** \`${b.sha}\`  \n`);
  if (b.upstream) md.appendMarkdown(`→ ${b.upstream}${b.upstreamGone ? ' (gone)' : ''}  \n`);
  md.appendMarkdown(`\n${b.subject}`);
  item.tooltip = md;

  item.contextValue = b.remote ? 'branch:remote' : b.current ? 'branch:current' : 'branch:local';
  return item;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
