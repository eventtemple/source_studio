import * as vscode from 'vscode';
import { GitRepository } from '../git/repository';
import { RepoManager } from '../model/repoManager';
import { reportError } from '../commands/util';

interface Draft {
  subject: string;
  body: string;
}

type InMessage =
  | { type: 'ready' }
  | { type: 'commit'; subject: string; body: string; amend: boolean; noVerify: boolean; signoff: boolean; push: boolean }
  | { type: 'amendToggled'; on: boolean; subject: string; body: string }
  | { type: 'draft'; subject: string; body: string }
  | { type: 'cancel' };

/** lazygit-style commit popup: subject + description + amend/no-verify/sign-off, as an editor tab. */
export class CommitPanel {
  private static current: CommitPanel | undefined;

  static show(repos: RepoManager, repo: GitRepository, state: vscode.Memento, extensionUri: vscode.Uri): void {
    if (CommitPanel.current) {
      CommitPanel.current.repo = repo;
      CommitPanel.current.panel.reveal();
      void CommitPanel.current.load();
      return;
    }
    CommitPanel.current = new CommitPanel(repos, repo, state, extensionUri);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly repos: RepoManager,
    private repo: GitRepository,
    private readonly state: vscode.Memento,
    extensionUri: vscode.Uri,
  ) {
    this.panel = vscode.window.createWebviewPanel('sourcestudio.commit', 'Commit', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [extensionUri],
    });
    this.panel.iconPath = new vscode.ThemeIcon('git-commit');
    this.panel.webview.html = html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((m: InMessage) => void this.onMessage(m), undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.disposables.push(
      repos.onDidChangeStatus((r) => {
        if (r === this.repo) void this.panel.webview.postMessage({ type: 'status', ...this.statusInfo() });
      }),
    );
  }

  private draftKey(): string {
    return `sourcestudio.commitDraft:${this.repo.root}`;
  }

  private statusInfo() {
    const staged = this.repo.status.files.filter((f) => f.index !== '.' && f.kind === 'tracked').length;
    const conflicts = this.repo.status.files.filter((f) => f.kind === 'unmerged').length;
    return { repo: this.repo.name, branch: this.repo.status.head, staged, conflicts, operation: this.repo.operation ?? '' };
  }

  /** Sends initial content: saved draft, else template + branch prefix. */
  private async load(): Promise<void> {
    this.panel.title = `Commit — ${this.repo.name}`;
    const draft = this.state.get<Draft>(this.draftKey());
    let subject = draft?.subject ?? '';
    let body = draft?.body ?? '';
    if (!draft) {
      subject = branchPrefix(this.repo.status.head);
      body = await this.repo.commitTemplate();
    }
    void this.panel.webview.postMessage({ type: 'init', subject, body, ...this.statusInfo() });
  }

  private async onMessage(m: InMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.load();
        break;
      case 'draft':
        await this.state.update(this.draftKey(), m.subject || m.body ? { subject: m.subject, body: m.body } : undefined);
        break;
      case 'amendToggled': {
        if (!m.on) return;
        // Pre-fill from HEAD unless the user has already typed something.
        const current = await this.repo.fullMessage('HEAD').catch(() => '');
        const [first, ...rest] = current.split('\n');
        const hasText = m.subject.trim() || m.body.replace(/^#.*$/gm, '').trim();
        if (!hasText || (await vscode.window.showInformationMessage('Replace the text with HEAD\u2019s message?', 'Replace', 'Keep')) === 'Replace') {
          void this.panel.webview.postMessage({ type: 'fill', subject: first ?? '', body: rest.join('\n').replace(/^\n+/, '') });
        }
        break;
      }
      case 'cancel':
        this.panel.dispose();
        break;
      case 'commit':
        await this.commit(m);
        break;
    }
  }

  private async commit(m: Extract<InMessage, { type: 'commit' }>): Promise<void> {
    const repo = this.repo;
    const subject = m.subject.trim();
    if (!subject) {
      void vscode.window.showWarningMessage('A commit subject is required.');
      return;
    }
    const message = m.body.trim() ? `${subject}\n\n${m.body.replace(/\s+$/, '')}` : subject;
    try {
      await repo.commit(message, { amend: m.amend, noVerify: m.noVerify, signoff: m.signoff });
      await this.state.update(this.draftKey(), undefined);
      await repo.refresh();
      this.panel.dispose();
      if (m.push) {
        this.repos.setActive(repo);
        await vscode.commands.executeCommand('sourcestudio.push');
      }
    } catch (e) {
      reportError(e);
      void this.panel.webview.postMessage({ type: 'failed' });
    }
  }

  private dispose(): void {
    CommitPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
  }
}

/** `PLA-123` from `feature/PLA-123-thing` → `PLA-123: `, per the sourcestudio.commit.* settings. */
export function branchPrefix(branch: string): string {
  const cfg = vscode.workspace.getConfiguration('sourcestudio.commit');
  const pattern = cfg.get<string>('branchPrefixPattern', '');
  const format = cfg.get<string>('branchPrefixFormat', '{match}: ');
  if (!pattern) return '';
  try {
    const m = new RegExp(pattern).exec(branch);
    const match = m?.[1] ?? m?.[0];
    return match ? format.replace('{match}', match) : '';
  } catch {
    return '';
  }
}

function html(webview: vscode.Webview): string {
  const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  const mod = process.platform === 'darwin' ? '⌘' : 'Ctrl';
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 18px 24px; max-width: 900px; }
  h2 { font-weight: 400; margin: 0 0 4px; }
  .meta { opacity: 0.75; margin-bottom: 16px; }
  .meta .warn { color: var(--vscode-editorWarning-foreground); }
  label { display: block; font-size: 0.9em; opacity: 0.8; margin: 12px 0 4px; }
  input[type=text], input:not([type]), textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 6px 8px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); border-radius: 2px; }
  input[type=checkbox] { width: auto; margin: 0; accent-color: var(--vscode-button-background); }
  input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
  textarea { min-height: 220px; resize: vertical; line-height: 1.4; }
  .row { display: flex; align-items: center; gap: 8px; }
  .counter { font-size: 0.85em; opacity: 0.6; min-width: 48px; text-align: right; }
  .counter.warn { color: var(--vscode-editorWarning-foreground); opacity: 1; }
  .counter.bad { color: var(--vscode-errorForeground); opacity: 1; }
  .toggles { display: flex; gap: 18px; margin: 14px 0 18px; flex-wrap: wrap; }
  .toggles label { display: flex; align-items: center; gap: 6px; margin: 0; cursor: pointer; opacity: 1; white-space: nowrap; }
  .actions { display: flex; gap: 8px; align-items: center; }
  button { padding: 6px 14px; border: 0; border-radius: 2px; cursor: pointer; font-family: inherit; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .hint { margin-left: auto; opacity: 0.55; font-size: 0.85em; }
  .ruler { position: relative; }
</style>
</head>
<body>
<h2 id="title">Commit</h2>
<div class="meta" id="meta"></div>

<label for="subject">Subject</label>
<div class="row"><input id="subject" autocomplete="off" spellcheck="true"><span class="counter" id="count">0/50</span></div>

<label for="body">Description <span style="opacity:.6">(lines starting with # are ignored)</span></label>
<textarea id="body" spellcheck="true"></textarea>

<div class="toggles">
  <label><input type="checkbox" id="amend"> Amend last commit</label>
  <label><input type="checkbox" id="noverify"> Skip hooks (--no-verify)</label>
  <label><input type="checkbox" id="signoff"> Sign-off</label>
</div>

<div class="actions">
  <button class="primary" id="commit">Commit</button>
  <button class="secondary" id="commitPush">Commit &amp; Push</button>
  <button class="secondary" id="cancel">Cancel</button>
  <span class="hint">${mod}+Enter to commit · Esc to cancel</span>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const subject = $('subject'), body = $('body'), amend = $('amend');
  let staged = 0;

  function updateCounter() {
    const n = subject.value.length;
    const c = $('count');
    c.textContent = n + '/50';
    c.className = 'counter' + (n > 72 ? ' bad' : n > 50 ? ' warn' : '');
  }
  function updateButtons() {
    const can = subject.value.trim().length > 0 && (staged > 0 || amend.checked);
    $('commit').disabled = !can; $('commitPush').disabled = !can;
  }
  let draftTimer;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => vscode.postMessage({ type: 'draft', subject: subject.value, body: body.value }), 400);
  }
  function submit(push) {
    if ($('commit').disabled) return;
    $('commit').disabled = true; $('commitPush').disabled = true;
    vscode.postMessage({ type: 'commit', subject: subject.value, body: body.value, amend: amend.checked, noVerify: $('noverify').checked, signoff: $('signoff').checked, push });
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'init') {
      subject.value = m.subject; body.value = m.body;
      applyStatus(m); updateCounter(); updateButtons();
      subject.focus(); subject.setSelectionRange(subject.value.length, subject.value.length);
    } else if (m.type === 'status') {
      applyStatus(m); updateButtons();
    } else if (m.type === 'fill') {
      subject.value = m.subject; body.value = m.body; updateCounter(); updateButtons(); saveDraft();
    } else if (m.type === 'failed') {
      updateButtons();
    }
  });

  function applyStatus(s) {
    staged = s.staged;
    $('title').textContent = 'Commit to ' + s.branch;
    let meta = s.repo + ' · ' + (s.staged === 1 ? '1 staged file' : s.staged + ' staged files');
    if (s.conflicts) meta += ' · <span class="warn">' + s.conflicts + ' unresolved conflict(s)</span>';
    if (s.operation) meta += ' · <span class="warn">' + s.operation + ' in progress — use Continue instead</span>';
    if (!s.staged && !amend.checked) meta += ' · <span class="warn">nothing staged</span>';
    $('meta').innerHTML = meta;
  }

  subject.addEventListener('input', () => { updateCounter(); updateButtons(); saveDraft(); });
  body.addEventListener('input', saveDraft);
  amend.addEventListener('change', () => { updateButtons(); vscode.postMessage({ type: 'amendToggled', on: amend.checked, subject: subject.value, body: body.value }); });
  $('commit').addEventListener('click', () => submit(false));
  $('commitPush').addEventListener('click', () => submit(true));
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(e.shiftKey); }
    else if (e.key === 'Escape') { e.preventDefault(); vscode.postMessage({ type: 'cancel' }); }
    else if (e.key === 'Enter' && e.target === subject) { e.preventDefault(); body.focus(); }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
