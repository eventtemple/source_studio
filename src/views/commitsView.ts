import * as vscode from 'vscode';
import { layoutGraph } from '../git/graph';
import { GitRepository } from '../git/repository';
import { Commit } from '../git/types';
import { RepoManager } from '../model/repoManager';

const PAGE = 300;

/** What the webview sends back. */
type InMessage =
  | { type: 'ready' }
  | { type: 'command'; command: string; sha?: string }
  | { type: 'loadMore' }
  | { type: 'toggleAll' }
  | { type: 'focusView'; id: string };

export interface CommitContext {
  sha: string;
  parents: string[];
  subject: string;
  repoRoot: string;
}

export class CommitsView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private commits: Commit[] = [];
  private unpushed = new Set<string>();
  private allBranches = false;
  private limit = PAGE;
  private repoForData: GitRepository | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private reloadTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repos: RepoManager,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.disposables.push(
      repos.onDidChangeActive(() => {
        this.limit = PAGE;
        this.scheduleReload();
      }),
      repos.onDidChangeStatus((r) => {
        if (r === repos.active) this.scheduleReload();
      }),
    );
  }

  /** Finds a loaded commit by SHA (for commands that only get a sha). */
  commit(sha: string): CommitContext | undefined {
    const c = this.commits.find((x) => x.sha === sha);
    return c && this.repoForData ? { sha, parents: c.parents, subject: c.subject, repoRoot: this.repoForData.root } : undefined;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = html(view.webview);
    view.webview.onDidReceiveMessage((m: InMessage) => void this.onMessage(m), undefined, this.disposables);
    view.onDidChangeVisibility(() => {
      if (view.visible) this.scheduleReload();
    });
  }

  private async onMessage(m: InMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.reload();
        break;
      case 'loadMore':
        this.limit += PAGE;
        await this.reload();
        break;
      case 'toggleAll':
        this.allBranches = !this.allBranches;
        await this.reload();
        break;
      case 'focusView':
        await vscode.commands.executeCommand(`${m.id}.focus`);
        break;
      case 'command': {
        const ctx = m.sha ? this.commit(m.sha) : undefined;
        await vscode.commands.executeCommand(m.command, ctx);
        break;
      }
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), 150);
  }

  private async reload(): Promise<void> {
    const repo = this.repos.active;
    if (!this.view) return;
    if (!repo) {
      this.view.title = 'Commits';
      void this.view.webview.postMessage({ type: 'data', rows: [], width: 0, repo: '', allBranches: this.allBranches, more: false });
      return;
    }
    const [commits, unpushed] = await Promise.all([repo.log({ all: this.allBranches, limit: this.limit + 1 }), repo.unpushed()]);
    const more = commits.length > this.limit;
    this.commits = commits.slice(0, this.limit);
    this.unpushed = unpushed;
    this.repoForData = repo;

    const { rows, width } = layoutGraph(this.commits);
    const head = repo.status.oid;
    this.view.title = `Commits — ${repo.name}${this.allBranches ? ' (all)' : ''}`;
    void this.view.webview.postMessage({
      type: 'data',
      repo: repo.name,
      allBranches: this.allBranches,
      more,
      width,
      rows: rows.map((r) => ({
        sha: r.commit.sha,
        short: r.commit.sha.slice(0, 7),
        subject: r.commit.subject,
        author: r.commit.author,
        date: r.commit.date,
        refs: r.commit.refs,
        col: r.col,
        incoming: r.incoming,
        head: r.commit.sha === head,
        unpushed: this.unpushed.has(r.commit.sha),
        merge: r.commit.parents.length > 1,
      })),
    });
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.disposables.forEach((d) => d.dispose());
  }
}

function html(webview: vscode.Webview): string {
  const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --row: 22px; --lane: 14px; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); overflow-x: hidden; }
  #wrap { position: relative; outline: none; }
  #graph { position: absolute; top: 0; left: 4px; pointer-events: none; }
  .row { display: flex; align-items: center; height: var(--row); line-height: var(--row); white-space: nowrap; cursor: pointer; padding-right: 8px; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.selected { background: var(--vscode-list-inactiveSelectionBackground); }
  #wrap:focus .row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .spacer { flex: none; }
  .ref { flex: none; font-size: 0.85em; padding: 0 5px; margin-right: 4px; border-radius: 3px; line-height: 16px; border: 1px solid var(--vscode-badge-background); color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
  .ref.head { border-color: var(--vscode-charts-green); background: transparent; color: var(--vscode-charts-green); font-weight: 600; }
  .ref.remote { opacity: 0.75; background: transparent; color: var(--vscode-foreground); border-color: var(--vscode-widget-border, var(--vscode-badge-background)); }
  .ref.tag { background: transparent; color: var(--vscode-charts-yellow); border-color: var(--vscode-charts-yellow); }
  .subject { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; }
  .subject.unpushed { font-style: italic; }
  .meta { flex: none; opacity: 0.6; margin-left: 10px; font-size: 0.9em; }
  .sha { font-family: var(--vscode-editor-font-family); }
  .more { display: block; width: 100%; margin: 6px 0; padding: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; cursor: pointer; }
  .empty { padding: 8px 12px; opacity: 0.7; }
</style>
</head>
<body>
<div id="wrap" tabindex="0"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const COLORS = ['#e06c75','#61afef','#98c379','#e5c07b','#c678dd','#56b6c2','#d19a66','#abb2bf'];
  const ROW = 22, LANE = 14, R = 4;
  let rows = [], width = 0, more = false, selected = 0;
  let selectedSha = null, selectedSubject = null;
  const wrap = document.getElementById('wrap');

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type !== 'data') return;
    rows = m.rows; width = m.width; more = m.more;
    // After a rewrite SHAs change; follow the commit by sha, then by subject, else keep the index.
    let i = rows.findIndex(r => r.sha === selectedSha);
    if (i < 0 && selectedSubject) i = rows.findIndex(r => r.subject === selectedSubject);
    selected = Math.max(0, Math.min(i >= 0 ? i : selected, rows.length - 1));
    remember();
    render();
  });

  function x(col) { return col * LANE + LANE / 2; }
  function y(i) { return i * ROW + ROW / 2; }

  function age(ts) {
    const s = Math.max(0, Date.now() / 1000 - ts);
    const m = s / 60, h = m / 60, d = h / 24;
    if (m < 1) return 'now'; if (m < 60) return Math.floor(m) + 'm'; if (h < 24) return Math.floor(h) + 'h';
    if (d < 14) return Math.floor(d) + 'd'; if (d < 63) return Math.floor(d / 7) + 'w'; if (d < 365) return Math.floor(d / 30) + 'mo';
    return Math.floor(d / 365) + 'y';
  }

  function esc(s) { return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function refBadge(ref) {
    let cls = 'ref';
    if (ref === 'HEAD') cls += ' head';
    else if (ref.startsWith('tag: ')) { cls += ' tag'; ref = ref.slice(5); }
    else if (ref.includes('/')) cls += ' remote';
    return '<span class="' + cls + '">' + esc(ref) + '</span>';
  }

  function render() {
    if (!rows.length) {
      wrap.innerHTML = '<div class="empty">No commits</div>';
      return;
    }
    const gw = width * LANE + 8;
    let svg = '<svg id="graph" width="' + gw + '" height="' + (rows.length * ROW) + '">';
    rows.forEach((r, i) => {
      for (const s of r.incoming) {
        const x1 = x(s.from), y1 = y(i - 1), x2 = x(s.to), y2 = y(i);
        const color = COLORS[s.to % COLORS.length];
        const d = x1 === x2
          ? 'M' + x1 + ' ' + y1 + 'L' + x2 + ' ' + y2
          : 'M' + x1 + ' ' + y1 + 'C' + x1 + ' ' + (y1 + ROW / 2) + ' ' + x2 + ' ' + (y2 - ROW / 2) + ' ' + x2 + ' ' + y2;
        svg += '<path d="' + d + '" stroke="' + color + '" stroke-width="2" fill="none"/>';
      }
    });
    rows.forEach((r, i) => {
      const color = COLORS[r.col % COLORS.length];
      const fill = r.unpushed ? 'var(--vscode-sideBar-background)' : color;
      const rad = r.head ? R + 1.5 : r.merge ? R - 1 : R;
      svg += '<circle cx="' + x(r.col) + '" cy="' + y(i) + '" r="' + rad + '" fill="' + fill + '" stroke="' + color + '" stroke-width="2"/>';
    });
    svg += '</svg>';

    let html = svg;
    rows.forEach((r, i) => {
      const ctx = JSON.stringify({ webviewSection: 'commit', sha: r.sha, preventDefaultContextMenuItems: true }).replace(/"/g, '&quot;');
      html += '<div class="row' + (i === selected ? ' selected' : '') + '" data-i="' + i + '" data-vscode-context="' + ctx + '">'
        + '<span class="spacer" style="width:' + gw + 'px"></span>'
        + r.refs.map(refBadge).join('')
        + '<span class="subject' + (r.unpushed ? ' unpushed' : '') + '" title="' + esc(r.subject) + '">' + esc(r.subject) + '</span>'
        + '<span class="meta">' + esc(r.author) + '</span>'
        + '<span class="meta">' + age(r.date) + '</span>'
        + '<span class="meta sha">' + r.short + '</span>'
        + '</div>';
    });
    if (more) html += '<button class="more" id="more">Load more…</button>';
    wrap.innerHTML = html;
    const sel = wrap.querySelector('.row.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function remember() {
    const r = rows[selected];
    selectedSha = r ? r.sha : null;
    selectedSubject = r ? r.subject : null;
  }

  function select(i) {
    selected = Math.max(0, Math.min(i, rows.length - 1));
    remember();
    wrap.querySelectorAll('.row').forEach((el, j) => el.classList.toggle('selected', j === selected));
    const sel = wrap.querySelector('.row.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function cmd(command) {
    const r = rows[selected];
    if (r) vscode.postMessage({ type: 'command', command, sha: r.sha });
  }

  wrap.addEventListener('click', e => {
    if (e.target.id === 'more') { vscode.postMessage({ type: 'loadMore' }); return; }
    const row = e.target.closest('.row');
    if (!row) return;
    select(Number(row.dataset.i));
    cmd('sourcestudio.showCommit');
  });
  wrap.addEventListener('contextmenu', e => {
    const row = e.target.closest('.row');
    if (row) select(Number(row.dataset.i));
  });

  const KEYS = {
    'ArrowDown': () => select(selected + 1), 'j': () => select(selected + 1),
    'ArrowUp': () => select(selected - 1), 'k': () => select(selected - 1),
    'PageDown': () => select(selected + 20), 'PageUp': () => select(selected - 20),
    'Home': () => select(0), 'End': () => select(rows.length - 1),
    'Enter': () => cmd('sourcestudio.showCommit'),
    ' ': () => cmd('sourcestudio.checkoutCommit'),
    'n': () => cmd('sourcestudio.branchFromCommit'),
    'c': () => cmd('sourcestudio.cherryPick'),
    't': () => cmd('sourcestudio.revertCommit'),
    'g': () => cmd('sourcestudio.resetToCommit'),
    'y': () => cmd('sourcestudio.copySha'),
    'o': () => cmd('sourcestudio.openOnGitHub'),
    's': () => cmd('sourcestudio.squashCommit'),
    'f': () => cmd('sourcestudio.fixupCommit'),
    'r': () => cmd('sourcestudio.rewordCommit'),
    'd': () => cmd('sourcestudio.dropCommit'),
    'e': () => cmd('sourcestudio.editCommit'),
    'J': () => cmd('sourcestudio.moveCommitDown'),
    'K': () => cmd('sourcestudio.moveCommitUp'),
    'A': () => vscode.postMessage({ type: 'command', command: 'sourcestudio.amendCommit' }),
    'z': () => vscode.postMessage({ type: 'command', command: 'sourcestudio.undo' }),
    'Z': () => vscode.postMessage({ type: 'command', command: 'sourcestudio.redo' }),
    'a': () => vscode.postMessage({ type: 'toggleAll' }),
    '?': () => vscode.postMessage({ type: 'command', command: 'sourcestudio.showKeymap' }),
    '1': () => vscode.postMessage({ type: 'focusView', id: 'sourcestudio.repos' }),
    '2': () => vscode.postMessage({ type: 'focusView', id: 'sourcestudio.files' }),
    '3': () => vscode.postMessage({ type: 'focusView', id: 'sourcestudio.branches' }),
    '4': () => vscode.postMessage({ type: 'focusView', id: 'sourcestudio.worktrees' }),
    '6': () => vscode.postMessage({ type: 'focusView', id: 'sourcestudio.stashes' }),
  };
  wrap.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const fn = KEYS[e.key];
    if (fn) { e.preventDefault(); fn(); }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
