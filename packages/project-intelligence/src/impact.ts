import { tableKey } from './build';
import type { ProjectIndex } from './types';

/** Reverse import closure: every file that (transitively) imports any of `files`. */
export function dependents(index: ProjectIndex, files: string[], maxDepth = 6): string[] {
  const seen = new Set<string>();
  let frontier = files.filter((f) => index.facts[f] || index.importedBy[f]);
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next: string[] = [];
    for (const f of frontier) for (const p of index.importedBy[f] ?? []) if (!seen.has(p) && !files.includes(p)) (seen.add(p), next.push(p));
    frontier = next;
  }
  return [...seen].sort();
}

/** Test files covering any of `files` (directly, through imports, or being the files themselves). */
export function affectedTests(index: ProjectIndex, files: string[]): string[] {
  const tests = new Set<string>();
  const testSet = new Set(index.testFiles);
  for (const f of files) {
    if (testSet.has(f)) tests.add(f);
    for (const t of index.testsFor[f] ?? []) tests.add(t);
  }
  for (const d of dependents(index, files)) if (testSet.has(d)) tests.add(d);
  return [...tests].sort();
}

/**
 * Files that use `symbol` exported by `file`, following barrel re-exports
 * (`export { x } from './file'`, `export * from './file'`).
 */
export function symbolConsumers(index: ProjectIndex, file: string, symbol: string, depth = 5): { file: string; via: string }[] {
  const out = new Map<string, string>();
  const walk = (f: string, sym: string, via: string, d: number) => {
    if (d > depth) return;
    const users = [...(index.symbolUsers[`${f}#${sym}`] ?? []), ...(index.symbolUsers[`${f}#*`] ?? [])];
    for (const u of users) {
      if (u === file || out.has(u)) continue;
      out.set(u, via);
      const reexports = index.facts[u]?.imports.some((im) => im.reexport && (im.names.includes(sym) || im.names.includes('*')));
      if (reexports) walk(u, sym, `${via} -> ${u}`, d + 1);
    }
  };
  walk(file, symbol, file, 0);
  return [...out].map(([f, via]) => ({ file: f, via }));
}

export interface Hunk {
  file: string;
  /** New-side line range; for deletions in a file, start=end=the line after the removal. */
  start: number;
  end: number;
}

/** Parse `git diff -U0` output into new-side hunks. */
export function parseHunks(diffU0: string): Hunk[] {
  const hunks: Hunk[] = [];
  let file = '';
  for (const l of diffU0.split('\n')) {
    if (l.startsWith('+++ ')) file = l.startsWith('+++ b/') ? l.slice(6) : '';
    const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m && file) {
      const start = Number(m[1]);
      const len = m[2] === undefined ? 1 : Number(m[2]);
      hunks.push({ file, start: Math.max(1, start), end: Math.max(start, start + len - 1) });
    }
  }
  return hunks;
}

export interface ChangedSymbol {
  file: string;
  symbol: string;
  kind: string;
  exported: boolean;
}

/** Declarations (at HEAD) overlapped by the diff, i.e. what this change actually touched. */
export function changedSymbols(index: ProjectIndex, hunks: Hunk[]): ChangedSymbol[] {
  const out = new Map<string, ChangedSymbol>();
  for (const h of hunks) {
    for (const d of index.facts[h.file]?.declarations ?? []) {
      if (d.kind === 'method') continue;
      if (h.start <= d.endLine && h.end >= d.startLine) out.set(`${h.file}#${d.name}`, { file: h.file, symbol: d.name, kind: d.kind, exported: d.exported });
    }
  }
  return [...out.values()];
}

export interface ConsumerReport {
  symbol: ChangedSymbol;
  consumers: { file: string; via: string; changed: boolean }[];
}

/**
 * For the reviewer: exported symbols this diff changed, and who uses them.
 * Consumers that were NOT modified in the same change are the ones most likely to break.
 */
export function consumersOfChange(index: ProjectIndex, hunks: Hunk[], changedFiles: string[]): ConsumerReport[] {
  const changed = new Set(changedFiles);
  return changedSymbols(index, hunks)
    .filter((s) => s.exported)
    .map((s) => ({ symbol: s, consumers: symbolConsumers(index, s.file, s.symbol).map((c) => ({ ...c, changed: changed.has(c.file) })) }))
    .filter((r) => r.consumers.length > 0);
}

/** Other files that read/write the same tables as `files` — related entities and consumers. */
export function dataNeighbours(index: ProjectIndex, files: string[]): { table: string; files: string[] }[] {
  const keys = new Set<string>();
  for (const f of files) {
    for (const t of index.facts[f]?.tables ?? []) keys.add(tableKey(t.name));
    for (const r of index.facts[f]?.tableRefs ?? []) keys.add(tableKey(r));
  }
  return [...keys]
    .filter((k) => index.tableUsers[k])
    .map((k) => ({ table: k, files: index.tableUsers[k]!.filter((f) => !files.includes(f)) }))
    .filter((x) => x.files.length > 0);
}
