import * as vscode from 'vscode';
import { RepoManager } from './model/repoManager';
import { repoSummary } from './views/reposView';

/** `$(repo) name  $(git-branch) main ↑2 ●3` — click to switch the active repository. */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly repos: RepoManager) {
    this.item = vscode.window.createStatusBarItem('sourcestudio.active', vscode.StatusBarAlignment.Left, 100);
    this.item.name = 'Source Studio: Active Repository';
    this.item.command = 'sourcestudio.pickActiveRepo';
    this.disposables.push(
      this.item,
      repos.onDidChangeActive(() => this.update()),
      repos.onDidChangeStatus((r) => {
        if (r === repos.active) this.update();
      }),
    );
    this.update();
  }

  private update(): void {
    const repo = this.repos.active;
    if (!repo) {
      this.item.hide();
      return;
    }
    const multi = this.repos.repositories.length > 1;
    this.item.text = `${multi ? `$(repo) ${repo.name}  ` : ''}$(git-branch) ${repoSummary(repo)}`;
    this.item.tooltip = `${repo.root}\nClick to switch the active repository`;
    this.item.show();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
