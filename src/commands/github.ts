import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitRepository } from '../git/repository';
import { GitHubService } from '../github/githubService';
import { RepoManager } from '../model/repoManager';
import { BranchNode, BranchesView } from '../views/branchesView';
import { CommitContext, CommitsView } from '../views/commitsView';
import { FileNode } from '../views/filesView';
import { registerSafe, requireActive, withProgress } from './util';

interface Deps {
  repos: RepoManager;
  github: GitHubService;
  branchesView: BranchesView;
  commitsView: CommitsView;
}

export function registerGitHubCommands(context: vscode.ExtensionContext, { repos, github, branchesView, commitsView }: Deps): void {
  const noRemote = (repo: GitRepository) => void vscode.window.showInformationMessage(`${repo.name} doesn't have a GitHub remote.`);

  registerSafe(context, 'sourcestudio.githubSignIn', async () => {
    const repo = requireActive(repos);
    if (repo) await github.signIn(repo);
  });

  /** `o` in Branches: open the branch's PR, or the compare page to create one. */
  registerSafe(context, 'sourcestudio.openPullRequest', async (node?: BranchNode) => {
    const n = node?.type === 'branch' ? node : branchesView.selectedBranch;
    const repo = n?.repo ?? requireActive(repos);
    if (!repo) return;
    const branch = n?.branch ?? repo.currentBranch;
    if (!branch) return;
    const remote = await github.ensureRemote(repo);
    if (!remote) return noRemote(repo);

    const name = branch.remote ? branch.name.slice(branch.remote.length + 1) : branch.name;
    const pr = github.pullFor(repo, name);
    if (pr) {
      await vscode.env.openExternal(vscode.Uri.parse(pr.url));
      return;
    }
    if (!branch.remote) {
      // Ensure the branch exists on the remote before offering a compare page.
      if (!branch.upstream || branch.upstreamGone) {
        const push = await vscode.window.showInformationMessage(`${name} isn't on the remote yet. Push it first?`, { modal: true }, 'Push');
        if (push !== 'Push') return;
        await withProgress(`Pushing ${name}`, () => repo.push({ setUpstream: true }));
      } else if (branch.ahead) {
        const push = await vscode.window.showInformationMessage(`${name} has ${branch.ahead} unpushed commit(s). Push before opening the PR?`, 'Push', 'Open Anyway');
        if (push === 'Push') await withProgress(`Pushing ${name}`, () => repo.push());
        else if (!push) return;
      }
      await repo.refresh();
    }
    const base = await github.defaultBranch(repo);
    if (name === base) {
      void vscode.window.showInformationMessage(`${name} is the default branch — check out a feature branch to open a PR.`);
      return;
    }
    const url = `${remote.webUrl}/compare/${enc(base)}...${enc(name)}?expand=1`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  });

  registerSafe(context, 'sourcestudio.copyPullRequestUrl', async (node?: BranchNode) => {
    const n = node?.type === 'branch' ? node : branchesView.selectedBranch;
    if (!n) return;
    const name = n.branch.remote ? n.branch.name.slice(n.branch.remote.length + 1) : n.branch.name;
    const pr = github.pullFor(n.repo, name);
    if (!pr) {
      void vscode.window.showInformationMessage(`No open pull request for ${name}.`);
      return;
    }
    await vscode.env.clipboard.writeText(pr.url);
    vscode.window.setStatusBarMessage(`Copied ${pr.url}`, 3000);
  });

  // ---------------------------------------------------------------- open on GitHub

  type Target =
    | { kind: 'branch'; repo: GitRepository; name: string }
    | { kind: 'commit'; repo: GitRepository; sha: string }
    | { kind: 'file'; repo: GitRepository; relPath: string; sha: string; lines?: [number, number] };

  const targetFrom = (arg: unknown): Target | undefined => {
    // Branches view
    if (arg && typeof arg === 'object' && 'type' in arg && (arg as BranchNode).type === 'branch') {
      const b = (arg as Extract<BranchNode, { type: 'branch' }>).branch;
      return { kind: 'branch', repo: (arg as BranchNode).repo, name: b.remote ? b.name.slice(b.remote.length + 1) : b.name };
    }
    // Files view
    if (arg && typeof arg === 'object' && 'type' in arg && (arg as FileNode).type === 'file') {
      const n = arg as Extract<FileNode, { type: 'file' }>;
      return { kind: 'file', repo: n.repo, relPath: n.file.path, sha: n.repo.status.oid };
    }
    // Commits view (message or webview menu context)
    if (arg && typeof arg === 'object' && 'sha' in arg) {
      const a = arg as CommitContext | { sha: string };
      const ctx = 'repoRoot' in a ? a : commitsView.commit(a.sha);
      const repo = ctx && repos.repositories.find((r) => r.root === ctx.repoRoot);
      return repo && ctx ? { kind: 'commit', repo, sha: ctx.sha } : undefined;
    }
    // Active editor
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme === 'file') {
      const repo = repos.repositoryFor(editor.document.uri.fsPath);
      if (!repo) return undefined;
      const relPath = path.relative(repo.root, editor.document.uri.fsPath).split(path.sep).join('/');
      const s = editor.selection;
      const lines: [number, number] = [s.start.line + 1, Math.max(s.start.line, s.end.character === 0 && !s.isEmpty ? s.end.line - 1 : s.end.line) + 1];
      return { kind: 'file', repo, relPath, sha: repo.status.oid, lines };
    }
    const repo = repos.active;
    return repo?.currentBranch ? { kind: 'branch', repo, name: repo.currentBranch.name } : undefined;
  };

  const urlFor = async (t: Target): Promise<string | undefined> => {
    const remote = await github.ensureRemote(t.repo);
    if (!remote) return noRemote(t.repo), undefined;
    switch (t.kind) {
      case 'branch':
        return `${remote.webUrl}/tree/${enc(t.name)}`;
      case 'commit':
        return `${remote.webUrl}/commit/${t.sha}`;
      case 'file': {
        const frag = t.lines ? (t.lines[0] === t.lines[1] ? `#L${t.lines[0]}` : `#L${t.lines[0]}-L${t.lines[1]}`) : '';
        return `${remote.webUrl}/blob/${t.sha}/${t.relPath.split('/').map(enc).join('/')}${frag}`;
      }
    }
  };

  registerSafe(context, 'sourcestudio.openOnGitHub', async (arg?: unknown) => {
    const t = targetFrom(arg);
    if (!t) return;
    const url = await urlFor(t);
    if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
  });

  registerSafe(context, 'sourcestudio.copyGitHubUrl', async (arg?: unknown) => {
    const t = targetFrom(arg);
    if (!t) return;
    const url = await urlFor(t);
    if (url) {
      await vscode.env.clipboard.writeText(url);
      vscode.window.setStatusBarMessage(`Copied ${url}`, 3000);
    }
  });
}

function enc(s: string): string {
  return encodeURIComponent(s).replace(/%2F/g, '/');
}
