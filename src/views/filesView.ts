import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitRepository } from '../git/repository';
import { Area, FileStatus, areasOf, statusLetter } from '../git/types';
import { RepoManager } from '../model/repoManager';

export type FileNode =
  | { type: 'group'; area: Area; repo: GitRepository }
  | { type: 'dir'; area: Area; repo: GitRepository; relPath: string; children: FileNode[] }
  | { type: 'file'; area: Area; repo: GitRepository; file: FileStatus };

const GROUP_ORDER: Area[] = ['conflicted', 'staged', 'unstaged', 'untracked'];
const GROUP_LABEL: Record<Area, string> = {
  conflicted: 'Conflicts',
  staged: 'Staged Changes',
  unstaged: 'Changes',
  untracked: 'Untracked Files',
};

/** Flattens a node into the FileStatus entries beneath it. */
export function filesUnder(node: FileNode): FileStatus[] {
  switch (node.type) {
    case 'file':
      return [node.file];
    case 'dir':
      return node.children.flatMap(filesUnder);
    case 'group':
      return node.repo.status.files.filter((f) => areasOf(f).includes(node.area));
  }
}

export class FilesView implements vscode.TreeDataProvider<FileNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<FileNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  readonly treeView: vscode.TreeView<FileNode>;
  private readonly disposables: vscode.Disposable[] = [];
  private groups: FileNode[] = [];

  constructor(private readonly repos: RepoManager) {
    this.treeView = vscode.window.createTreeView('sourcestudio.files', {
      treeDataProvider: this,
      canSelectMany: true,
      showCollapseAll: true,
    });
    this.disposables.push(
      this.treeView,
      repos.onDidChangeActive(() => this.refresh()),
      repos.onDidChangeStatus((r) => {
        this.updateBadge();
        if (r === repos.active) this.refresh();
      }),
      this.treeView.onDidChangeCheckboxState((e) => void this.onCheckbox(e)),
    );
    this.refresh();
  }

  get selection(): readonly FileNode[] {
    return this.treeView.selection;
  }

  /** Activity-bar badge: changed files across every repository, like the built-in SCM view. */
  private updateBadge(): void {
    const counts = this.repos.repositories.map((r) => ({ name: r.name, n: r.status.files.length })).filter((c) => c.n > 0);
    const total = counts.reduce((sum, c) => sum + c.n, 0);
    this.treeView.badge = total
      ? { value: total, tooltip: counts.map((c) => `${c.name}: ${c.n} change${c.n === 1 ? '' : 's'}`).join('\n') }
      : undefined;
  }

  private refresh(): void {
    const repo = this.repos.active;
    this.treeView.title = repo ? `Files — ${repo.name}` : 'Files';
    this.treeView.message = repo && repo.status.files.length === 0 ? 'Working tree clean' : undefined;
    this.groups = [];
    if (repo) {
      for (const area of GROUP_ORDER) {
        if (repo.status.files.some((f) => areasOf(f).includes(area))) {
          this.groups.push({ type: 'group', area, repo });
        }
      }
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  // ---------------------------------------------------------------- tree

  getChildren(node?: FileNode): FileNode[] {
    if (!node) return this.groups;
    if (node.type === 'file') return [];
    if (node.type === 'dir') return node.children;
    return buildTree(node.repo, node.area, filesUnder(node));
  }

  getTreeItem(node: FileNode): vscode.TreeItem {
    switch (node.type) {
      case 'group': {
        const n = filesUnder(node).length;
        const item = new vscode.TreeItem(GROUP_LABEL[node.area], vscode.TreeItemCollapsibleState.Expanded);
        item.id = `${node.repo.root}|group|${node.area}`;
        item.description = String(n);
        item.contextValue = `group:${node.area}`;
        return item;
      }
      case 'dir': {
        const item = new vscode.TreeItem(path.posix.basename(node.relPath), vscode.TreeItemCollapsibleState.Expanded);
        item.id = `${node.repo.root}|${node.area}|dir|${node.relPath}`;
        item.resourceUri = node.repo.fileUri(node.relPath);
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = `dir:${node.area}`;
        item.checkboxState = checkboxFor(node.area);
        return item;
      }
      case 'file': {
        const f = node.file;
        const item = new vscode.TreeItem(path.posix.basename(f.path), vscode.TreeItemCollapsibleState.None);
        item.id = `${node.repo.root}|${node.area}|file|${f.path}`;
        item.resourceUri = node.repo.fileUri(f.path);
        item.iconPath = vscode.ThemeIcon.File;
        const letter = statusLetter(f, node.area);
        item.description = f.origPath ? `${letter}  ← ${f.origPath}` : letter;
        item.tooltip = `${f.path}\n${describe(letter)} (${node.area})`;
        item.contextValue = `file:${node.area}`;
        item.checkboxState = checkboxFor(node.area);
        item.command = { command: 'sourcestudio.openDiff', title: 'Open Diff', arguments: [node] };
        return item;
      }
    }
  }

  // ---------------------------------------------------------------- checkboxes

  private async onCheckbox(e: vscode.TreeCheckboxChangeEvent<FileNode>): Promise<void> {
    const toStage = new Set<string>();
    const toUnstage = new Set<string>();
    let repo: GitRepository | undefined;
    for (const [node, state] of e.items) {
      repo = node.repo;
      const target = state === vscode.TreeItemCheckboxState.Checked ? toStage : toUnstage;
      for (const f of filesUnder(node)) target.add(f.path);
    }
    if (!repo) return;
    try {
      await repo.stage([...toStage]);
      await repo.unstage([...toUnstage]);
    } finally {
      await repo.refresh();
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onDidChangeTreeData.dispose();
  }
}

// ------------------------------------------------------------------ helpers

function checkboxFor(area: Area): vscode.TreeItemCheckboxState | undefined {
  if (area === 'staged') return vscode.TreeItemCheckboxState.Checked;
  if (area === 'unstaged' || area === 'untracked') return vscode.TreeItemCheckboxState.Unchecked;
  return undefined;
}

/** Nests a flat file list into dir/file nodes. Single-child chains are not collapsed (yet). */
function buildTree(repo: GitRepository, area: Area, files: FileStatus[]): FileNode[] {
  type Dir = { type: 'dir'; area: Area; repo: GitRepository; relPath: string; children: FileNode[] };
  const root: Dir = { type: 'dir', area, repo, relPath: '', children: [] };
  const dirs = new Map<string, Dir>([['', root]]);

  const dirFor = (rel: string): Dir => {
    const existing = dirs.get(rel);
    if (existing) return existing;
    const parent = dirFor(path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel));
    const dir: Dir = { type: 'dir', area, repo, relPath: rel, children: [] };
    parent.children.push(dir);
    dirs.set(rel, dir);
    return dir;
  };

  for (const file of files) {
    const parent = path.posix.dirname(file.path);
    dirFor(parent === '.' ? '' : parent).children.push({ type: 'file', area, repo, file });
  }

  const sort = (nodes: FileNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return labelOf(a).localeCompare(labelOf(b));
    });
    for (const n of nodes) if (n.type === 'dir') sort(n.children);
  };
  sort(root.children);
  return root.children;
}

function labelOf(n: FileNode): string {
  return n.type === 'dir' ? n.relPath : n.type === 'file' ? n.file.path : n.area;
}

function describe(letter: string): string {
  return (
    { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Unmerged', '?': 'Untracked' }[
      letter
    ] ?? letter
  );
}
