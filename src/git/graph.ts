import { Commit } from './types';

export interface GraphSegment {
  /** Column in the row above. */
  from: number;
  /** Column in this row. */
  to: number;
}

export interface GraphRow {
  commit: Commit;
  /** Column of this commit's dot. */
  col: number;
  /** Rails entering this row from the row above. */
  incoming: GraphSegment[];
}

/**
 * Assigns a column to every commit and the rail segments between consecutive rows.
 * Input must be child-before-parent ordered (`git log --date-order` / `--topo-order`).
 *
 * Each lane holds the SHA it expects to meet next. A commit lands on the first lane
 * expecting it (or a free lane), its first parent inherits that lane, and every other
 * parent either joins a lane already expecting it or opens a new one.
 */
export function layoutGraph(commits: Commit[]): { rows: GraphRow[]; width: number } {
  const lanes: (string | null)[] = [];
  /** For each lane, the columns in the previous row that feed into it. */
  let sources: number[][] = [];
  const rows: GraphRow[] = [];
  let width = 0;

  const free = (): number => {
    const i = lanes.indexOf(null);
    if (i >= 0) return i;
    lanes.push(null);
    sources.push([]);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const matching = lanes.flatMap((sha, i) => (sha === commit.sha ? [i] : []));
    const col = matching.length ? matching[0] : free();

    const incoming: GraphSegment[] = [];
    lanes.forEach((sha, i) => {
      if (sha === null) return;
      const to = sha === commit.sha ? col : i;
      for (const from of sources[i] ?? [i]) incoming.push({ from, to });
    });

    for (const i of matching) lanes[i] = null;
    const nextSources: number[][] = lanes.map((sha, i) => (sha === null ? [] : [i]));

    const [first, ...rest] = commit.parents;
    lanes[col] = first ?? null;
    nextSources[col] = first ? [col] : [];
    for (const parent of rest) {
      let j = lanes.indexOf(parent);
      if (j >= 0) {
        nextSources[j].push(col);
      } else {
        j = free();
        lanes[j] = parent;
        nextSources[j] = [col];
      }
    }

    while (lanes.length && lanes[lanes.length - 1] === null) {
      lanes.pop();
      nextSources.pop();
    }
    sources = nextSources;
    width = Math.max(width, lanes.length, col + 1);
    rows.push({ commit, col, incoming });
  }

  return { rows, width };
}
