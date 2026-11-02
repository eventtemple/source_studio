/**
 * Builds partial patches from `git diff -U0` output for line/hunk staging.
 * With zero context every hunk is self-contained, so we can keep a subset of
 * hunks — or a subset of lines inside a hunk — and `git apply --unidiff-zero` it.
 */

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Body lines, each starting with '+', '-' or '\' (no-newline marker). */
  lines: string[];
}

export interface ParsedDiff {
  /** Everything before the first hunk: `diff --git`, `index`, `---`, `+++`, mode lines. */
  header: string[];
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiff(text: string): ParsedDiff {
  const header: string[] = [];
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of text.split('\n')) {
    const m = HUNK_RE.exec(line);
    if (m) {
      current = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      hunks.push(current);
    } else if (current) {
      if (line !== '') current.lines.push(line);
    } else if (line !== '') {
      header.push(line);
    }
  }
  return { header, hunks };
}

/** Line range on the "new" side that a hunk occupies. Deletion-only hunks sit between newStart and newStart+1. */
function newRange(h: Hunk): [number, number] {
  return h.newCount === 0 ? [h.newStart, h.newStart + 1] : [h.newStart, h.newStart + h.newCount - 1];
}

function overlaps(h: Hunk, start: number, end: number): boolean {
  const [a, b] = newRange(h);
  return a <= end && b >= start;
}

/**
 * Keeps only the parts of `hunk` relevant to new-side lines in [start, end].
 * '+' lines outside the selection are dropped; '-' lines are kept whenever the hunk intersects
 * (a partially selected modification stages the removal plus the chosen additions).
 * Returns undefined when nothing applies.
 */
function filterHunk(hunk: Hunk, start: number, end: number): Hunk | undefined {
  if (!overlaps(hunk, start, end)) return undefined;
  const out: string[] = [];
  let newLine = hunk.newStart;
  let keptPlus = 0;
  let keptMinus = 0;
  let lastKept = false;
  for (const line of hunk.lines) {
    if (line.startsWith('+')) {
      const selected = newLine >= start && newLine <= end;
      newLine++;
      if (selected) {
        out.push(line);
        keptPlus++;
      }
      lastKept = selected;
    } else if (line.startsWith('-')) {
      out.push(line);
      keptMinus++;
      lastKept = true;
    } else if (line.startsWith('\\')) {
      if (lastKept) out.push(line); // "\ No newline at end of file" belongs to the previous line
    }
  }
  if (keptPlus === 0 && keptMinus === 0) return undefined;
  // A hunk that had additions but none were selected is a pure deletion the user didn't ask for.
  if (keptPlus === 0 && hunk.newCount > 0) return undefined;
  return { ...hunk, oldCount: keptMinus, newCount: keptPlus, lines: out };
}

function renderHunk(h: Hunk): string {
  return `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@\n${h.lines.join('\n')}\n`;
}

/**
 * Builds a patch covering the new-side line range [start, end] (1-based, inclusive).
 * `wholeHunks` keeps every intersecting hunk intact instead of filtering lines.
 */
export function buildPatch(diff: ParsedDiff, start: number, end: number, wholeHunks = false): string | undefined {
  const kept = diff.hunks
    .map((h) => (wholeHunks ? (overlaps(h, start, end) ? h : undefined) : filterHunk(h, start, end)))
    .filter((h): h is Hunk => h !== undefined);
  if (kept.length === 0) return undefined;
  return diff.header.join('\n') + '\n' + kept.map(renderHunk).join('');
}
