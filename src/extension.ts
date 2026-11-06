import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { registerBranchCommands } from './commands/branches';
import { registerCommitCommands } from './commands/commits';
import { registerGitHubCommands } from './commands/github';
import { registerRebaseCommands } from './commands/rebase';
import { registerStagingCommands } from './commands/staging';
import { registerStashCommands } from './commands/stashes';
import { registerUndoCommands } from './commands/undo';
import { registerWorktreeCommands } from './commands/worktrees';
import { BlameController } from './blame/blameController';
import { GIT_SCHEME, GitContentProvider } from './diff/gitContentProvider';
import { prepareRebaseHelper } from './git/rebase';
import { GitHubService } from './github/githubService';
import { RepoManager } from './model/repoManager';
import { StatusBar } from './statusBar';
import { BranchesView } from './views/branchesView';
import { CommitsView } from './views/commitsView';
import { FilesView } from './views/filesView';
import { ReposView } from './views/reposView';
import { StashesView } from './views/stashesView';
import { WorktreesView } from './views/worktreesView';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const repos = new RepoManager(context.workspaceState);
  const contentProvider = new GitContentProvider(repos);
  const reposView = new ReposView(repos);
  const filesView = new FilesView(repos);
  const github = new GitHubService(repos);
  const branchesView = new BranchesView(repos, github);
  const worktreesView = new WorktreesView(repos);
  const stashesView = new StashesView(repos);
  const commitsView = new CommitsView(repos, context.extensionUri);
  const statusBar = new StatusBar(repos);
  const blame = new BlameController(repos, context.globalState);

  context.subscriptions.push(
    repos,
    github,
    contentProvider,
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, contentProvider),
    reposView,
    filesView,
    branchesView,
    worktreesView,
    stashesView,
    commitsView,
    vscode.window.registerWebviewViewProvider('sourcestudio.commits', commitsView),
    statusBar,
    blame,
  );
  blame.register(context);

  registerCommands(context, { repos, filesView, state: context.workspaceState, extensionUri: context.extensionUri });
  registerBranchCommands(context, { repos, branchesView });
  registerWorktreeCommands(context, { repos, worktreesView });
  registerStashCommands(context, { repos, stashesView });
  registerCommitCommands(context, { repos, commitsView });
  registerRebaseCommands(context, { repos, commitsView });
  registerUndoCommands(context, { repos });
  registerStagingCommands(context, { repos });
  registerGitHubCommands(context, { repos, github, branchesView, commitsView });

  await prepareRebaseHelper(context);

  await repos.rescan();
}

export function deactivate(): void {}
