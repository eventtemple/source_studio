import * as path from 'node:path';
import * as vscode from 'vscode';
import { openRefDiff } from '../diff/openDiff';
import { GitRepository } from '../git/repository';
import { EMPTY_TREE } from '../git/types';
import { RepoManager } from '../model/repoManager';
import { registerSafe, relativeAge, reportError } from '../commands/util';

export interface BlameLine {
  /** 1-based line in the current file. */
  line: number;
  sha: string;
  author: string;
  /** Unix seconds. */
  time: number;
  summary: string;
  uncommitted: boolean;
}

const UNCOMMITTED = /^0+$/;

/** Parses `git blame --porcelain`. Commit metadata is only emitted the first time a SHA appears. */
export function parseBlame(out: string): BlameLine[] {
  const lines: BlameLine[] = [];
  const meta = new Map<string, { author: string; time: number; summary: string }>();
  const rows = out.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(rows[i]);
    if (!header) continue;
    const sha = header[1];
    const line = Number(header[2]);
    const m = meta.get(sha) ?? { author: '', time: 0, summary: '' };
    while (i + 1 < rows.length && !rows[i + 1].startsWith('\t')) {
      const row = rows[++i];
      const sp = row.indexOf(' ');
      const key = sp < 0 ? row : row.slice(0, sp);
      const value = sp < 0 ? '' : row.slice(sp + 1);
      if (key === 'author') m.author = value;
      else if (key === 'author-time') m.time = Number(value);
      else if (key === 'summary') m.summary = value;
    }
    i++; // the "\t<content>" row
    meta.set(sha, m);
    lines.push({ line, sha, ...m, uncommitted: UNCOMMITTED.test(sha) });
  }
  return lines.sort((a, b) => a.line - b.line);
}

export class BlameController implements vscode.Disposable {
  private readonly fileBlameOn = new Set<string>();
  private lineBlameOn: boolean;
  private readonly cache = new Map<string, BlameLine[]>();
  private readonly disposables: vscode.Disposable[] = [];

  private readonly fileDeco = vscode.window.createTextEditorDecorationType({
    before: { color: new vscode.ThemeColor('editorLineNumber.foreground'), margin: '0 1.5em 0 0' },
    isWholeLine: true,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly lineDeco = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 3em', fontStyle: 'italic' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });

  constructor(
    private readonly repos: RepoManager,
    private readonly state: vscode.Memento,
  ) {
    this.lineBlameOn = state.get<boolean>('sourcestudio.lineBlame', false);
    this.disposables.push(
      this.fileDeco,
      this.lineDeco,
      vscode.window.onDidChangeActiveTextEditor(() => void this.renderAll()),
      vscode.window.onDidChangeTextEditorSelection((e) => void this.renderLine(e.textEditor)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) {
          this.cache.delete(e.document.uri.toString());
          void this.renderAll(e.document);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        this.cache.delete(d.uri.toString());
        this.fileBlameOn.delete(d.uri.toString());
      }),
      repos.onDidChangeStatus(() => {
        this.cache.clear(); // a commit changes which lines are "not committed yet"
        void this.renderAll();
      }),
    );
  }

  // ---------------------------------------------------------------- data

  private repoFor(doc: vscode.TextDocument): { repo: GitRepository; relPath: string } | undefined {
    if (doc.uri.scheme !== 'file') return undefined;
    const repo = this.repos.repositoryFor(doc.uri.fsPath);
    if (!repo) return undefined;
    return { repo, relPath: path.relative(repo.root, doc.uri.fsPath).split(path.sep).join('/') };
  }

  async blame(doc: vscode.TextDocument): Promise<BlameLine[] | undefined> {
    const key = doc.uri.toString();
    const cached = this.cache.get(key);
    if (cached) return cached;
    const t = this.repoFor(doc);
    if (!t) return undefined;
    try {
      const lines = parseBlame(await t.repo.blame(t.relPath, doc.isDirty ? doc.getText() : undefined));
      this.cache.set(key, lines);
      return lines;
    } catch {
      return undefined; // untracked, or outside the index
    }
  }

  // ---------------------------------------------------------------- rendering

  private async renderAll(onlyDoc?: vscode.TextDocument): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      if (onlyDoc && editor.document !== onlyDoc) continue;
      await this.renderFile(editor);
      await this.renderLine(editor);
    }
  }

  private async renderFile(editor: vscode.TextEditor): Promise<void> {
    if (!this.fileBlameOn.has(editor.document.uri.toString())) {
      editor.setDecorations(this.fileDeco, []);
      return;
    }
    const lines = await this.blame(editor.document);
    if (!lines) {
      editor.setDecorations(this.fileDeco, []);
      return;
    }
    const authorWidth = Math.min(16, Math.max(6, ...lines.map((l) => l.author.length)));
    const width = 7 + 2 + authorWidth + 2 + 4;
    const options: vscode.DecorationOptions[] = [];
    let prev: string | undefined;
    for (const l of lines) {
      if (l.line > editor.document.lineCount) break;
      const first = l.sha !== prev;
      prev = l.sha;
      const text = first ? annotation(l, authorWidth) : '';
      options.push({
        range: editor.document.lineAt(l.line - 1).range,
        renderOptions: { before: { contentText: text.padEnd(width, '\u00a0') } },
        hoverMessage: hover(l, this.repoFor(editor.document)?.repo),
      });
    }
    editor.setDecorations(this.fileDeco, options);
  }

  private async renderLine(editor: vscode.TextEditor): Promise<void> {
    if (!this.lineBlameOn || editor.document.uri.scheme !== 'file') {
      editor.setDecorations(this.lineDeco, []);
      return;
    }
    const lines = await this.blame(editor.document);
    const lineNo = editor.selection.active.line + 1;
    const l = lines?.find((x) => x.line === lineNo);
    if (!l) {
      editor.setDecorations(this.lineDeco, []);
      return;
    }
    const text = l.uncommitted ? 'Not committed yet' : `${l.author}, ${relativeAge(l.time)} ago • ${l.summary}`;
    const range = editor.document.lineAt(lineNo - 1).range;
    editor.setDecorations(this.lineDeco, [
      { range: new vscode.Range(range.end, range.end), renderOptions: { after: { contentText: text } }, hoverMessage: hover(l, this.repoFor(editor.document)?.repo) },
    ]);
  }

  // ---------------------------------------------------------------- commands

  register(context: vscode.ExtensionContext): void {
    registerSafe(context, 'sourcestudio.toggleFileBlame', async (arg?: vscode.Uri | { type: string; repo: GitRepository; file?: { path: string } }) => {
      let uri: vscode.Uri | undefined;
      if (arg instanceof vscode.Uri) uri = arg;
      else if (arg && 'file' in arg && arg.file) uri = arg.repo.fileUri(arg.file.path);
      else uri = vscode.window.activeTextEditor?.document.uri;
      if (!uri) return;
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri!.toString()) ?? (await vscode.window.showTextDocument(uri));
      const key = uri.toString();
      if (this.fileBlameOn.has(key)) this.fileBlameOn.delete(key);
      else this.fileBlameOn.add(key);
      await this.renderFile(editor);
      if (this.fileBlameOn.has(key) && !(await this.blame(editor.document))) {
        void vscode.window.showInformationMessage('No blame available — the file is untracked or outside a repository.');
        this.fileBlameOn.delete(key);
      }
    });

    registerSafe(context, 'sourcestudio.toggleLineBlame', async () => {
      this.lineBlameOn = !this.lineBlameOn;
      await this.state.update('sourcestudio.lineBlame', this.lineBlameOn);
      await this.renderAll();
      vscode.window.setStatusBarMessage(`Line blame ${this.lineBlameOn ? 'on' : 'off'}`, 2000);
    });

    registerSafe(context, 'sourcestudio.showLineBlame', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const t = this.repoFor(editor.document);
      const lines = await this.blame(editor.document);
      const lineNo = editor.selection.active.line + 1;
      const l = lines?.find((x) => x.line === lineNo);
      if (!l || !t) {
        void vscode.window.showInformationMessage('No blame information for this line.');
        return;
      }
      if (l.uncommitted) {
        void vscode.window.showInformationMessage(`Line ${lineNo}: not committed yet.`);
        return;
      }
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(diff) Show commit', action: 'show' },
          { label: '$(copy) Copy SHA', action: 'copy' },
          { label: '$(eye) Toggle file blame', action: 'file' },
        ],
        { placeHolder: `${l.sha.slice(0, 7)} · ${l.author} · ${new Date(l.time * 1000).toLocaleString()} — ${l.summary}` },
      );
      if (picked?.action === 'show') await showCommit(t.repo, l.sha);
      else if (picked?.action === 'copy') await vscode.env.clipboard.writeText(l.sha);
      else if (picked?.action === 'file') await vscode.commands.executeCommand('sourcestudio.toggleFileBlame', editor.document.uri);
    });

    registerSafe(context, 'sourcestudio.showCommitSha', async (args: { repoRoot: string; sha: string }) => {
      const repo = this.repos.repositories.find((r) => r.root === args.repoRoot);
      if (repo) await showCommit(repo, args.sha);
    });

    registerSafe(context, 'sourcestudio.copyText', (text: string) => vscode.env.clipboard.writeText(text));
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

function annotation(l: BlameLine, authorWidth: number): string {
  if (l.uncommitted) return `${'·'.repeat(7)}  ${'uncommitted'.padEnd(authorWidth).slice(0, authorWidth)}`;
  const author = l.author.length > authorWidth ? l.author.slice(0, authorWidth - 1) + '…' : l.author.padEnd(authorWidth);
  return `${l.sha.slice(0, 7)}  ${author}  ${relativeAge(l.time).padStart(4)}`;
}

function hover(l: BlameLine, repo?: GitRepository): vscode.MarkdownString | undefined {
  if (l.uncommitted) return new vscode.MarkdownString('Not committed yet');
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.appendMarkdown(`**${l.author}** · ${new Date(l.time * 1000).toLocaleString()} · \`${l.sha.slice(0, 7)}\`\n\n${l.summary}`);
  if (repo) {
    const show = encodeURIComponent(JSON.stringify({ repoRoot: repo.root, sha: l.sha }));
    const copy = encodeURIComponent(JSON.stringify(l.sha));
    md.appendMarkdown(`\n\n[$(diff) Show commit](command:sourcestudio.showCommitSha?${show}) · [$(copy) Copy SHA](command:sourcestudio.copyText?${copy})`);
  }
  return md;
}

async function showCommit(repo: GitRepository, sha: string): Promise<void> {
  try {
    const [c] = await repo.revList(`${sha}~1`, sha).catch(() => []);
    const subject = c?.subject ?? '';
    const parent = c && c.parents.length ? c.parents[0] : EMPTY_TREE;
    await openRefDiff(repo, parent, sha, `${sha.slice(0, 7)}: ${subject}`);
  } catch (e) {
    reportError(e);
  }
}
