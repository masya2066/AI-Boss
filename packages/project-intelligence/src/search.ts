import { tableKey } from './build';
import { affectedTests, dataNeighbours, dependents } from './impact';
import type { ProjectIndex } from './types';

// Lexical concept search (BM25 over code facts) + deterministic graph expansion.
// Embeddings are deliberately not required: exact symbols, the import graph and
// shared tables give guarantees that similarity search cannot.

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'is', 'be', 'it', 'as', 'at', 'from', 'this', 'that', 'add', 'new', 'make', 'use', 'should', 'must', 'can', 'src', 'lib', 'index', 'ts', 'tsx', 'js', 'test', 'tests', 'spec', 'get', 'set', 'app']);

export function stem(w: string): string {
  if (w.length <= 3) return w;
  let s = w;
  // 1. plural (never on -us/-ss/-is: status, class, analysis)
  if (s.endsWith('ies')) s = s.slice(0, -3) + 'y';
  else if (/(sses|xes|ches|shes|zes)$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith('s') && !/(us|ss|is)$/.test(s)) s = s.slice(0, -1);
  // 2. verb forms: bookings -> booking -> book, cancelled -> cancel, paused -> paus
  if (s.endsWith('ing') && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith('ed') && s.length > 4) s = s.slice(0, -2);
  if (/(ll|tt|pp|nn|mm)$/.test(s) && s.length > 4) s = s.slice(0, -1);
  if (s.endsWith('e') && s.length > 4) s = s.slice(0, -1);
  return s;
}

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

interface Doc {
  file: string;
  tf: Map<string, number>;
  len: number;
  why: Map<string, string>;
}

const docsCache = new WeakMap<ProjectIndex, { docs: Doc[]; df: Map<string, number>; avg: number }>();

function docs(index: ProjectIndex) {
  const hit = docsCache.get(index);
  if (hit) return hit;
  const out: Doc[] = [];
  for (const file of index.files) {
    const f = index.facts[file];
    const tf = new Map<string, number>();
    const why = new Map<string, string>();
    const add = (text: string, w: number, label: string) => {
      for (const t of tokenize(text)) {
        tf.set(t, (tf.get(t) ?? 0) + w);
        if (!why.has(t)) why.set(t, `${label}: ${text.length > 60 ? text.slice(0, 60) + '…' : text}`);
      }
    };
    add(file, 2, 'path');
    if (f) {
      for (const d of f.declarations) add(d.name, d.exported ? 3 : 2, d.kind);
      for (const r of f.routes) add(`${r.method} ${r.path}`, 3, 'endpoint');
      for (const p of f.pages) add(p.path, 2.5, 'page');
      for (const t of f.tables) add([t.name, t.alias ?? '', ...t.columns].join(' '), 3, 'table');
      for (const r of f.tableRefs) add(r, 2, 'uses table');
      for (const t of f.testTitles) add(t, 1.5, 'test');
      for (const e of f.envVars) add(e, 1, 'env');
      // weak signal, once per distinct token: catches fields/properties like pausedUntil
      const seen = new Set<string>();
      for (const id of f.identifiers ?? []) for (const t of tokenize(id)) if (!seen.has(t)) (seen.add(t), tf.set(t, (tf.get(t) ?? 0) + 0.6), why.has(t) || why.set(t, `uses ${id}`));
    }
    let len = 0;
    for (const v of tf.values()) len += v;
    out.push({ file, tf, len: len || 1, why });
  }
  const df = new Map<string, number>();
  for (const d of out) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avg = out.reduce((s, d) => s + d.len, 0) / Math.max(1, out.length);
  const r = { docs: out, df, avg };
  docsCache.set(index, r);
  return r;
}

export interface SearchHit {
  file: string;
  score: number;
  matched: string[];
  reasons: string[];
}

export function search(index: ProjectIndex, query: string | string[], limit = 20): SearchHit[] {
  const terms = [...new Set((Array.isArray(query) ? query : [query]).flatMap(tokenize))];
  if (!terms.length) return [];
  const { docs: ds, df, avg } = docs(index);
  const N = ds.length;
  const k1 = 1.2;
  const b = 0.75;
  const hits: SearchHit[] = [];
  for (const d of ds) {
    let score = 0;
    const matched: string[] = [];
    for (const t of terms) {
      const tf = d.tf.get(t);
      if (!tf) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * d.len) / avg));
      matched.push(t);
    }
    // Reward files that match more distinct query concepts.
    if (score > 0) hits.push({ file: d.file, score: score * (1 + 0.5 * (matched.length - 1)), matched, reasons: matched.map((t) => d.why.get(t)!).filter(Boolean) });
  }
  return hits.sort((a, b2) => b2.score - a.score).slice(0, limit);
}

export interface ContextFile {
  file: string;
  score: number;
  why: string[];
}

export interface TaskContext {
  commit: string;
  terms: string[];
  files: ContextFile[];
  endpoints: { method: string; path: string; file: string }[];
  pages: { path: string; file: string }[];
  tables: { name: string; columns: string[]; definedIn: string; usedBy: string[] }[];
  tests: string[];
  env: string[];
  integrations: string[];
}

/**
 * Systematic exploration around a task: concept hits + agent-named seeds, then
 * consumers (reverse imports), dependencies, tests, and every file that touches
 * the same tables (notifications, analytics, schedules … of the same entity).
 */
export function buildContext(index: ProjectIndex, o: { terms: string[]; seeds?: string[]; limit?: number }): TaskContext {
  // Direct evidence (search hit / named by the researcher) dominates; graph neighbours get a
  // fraction of the seed's score (max over relations, plus a small bonus for many relations),
  // so hub files and shared test helpers don't outrank the code that actually matches.
  const direct = new Map<string, { score: number; why: string[] }>();
  const relScores = new Map<string, { best: number; n: number; why: string[] }>();
  const files = new Set(index.files);
  const hits = search(index, o.terms, 15);
  const top = hits[0]?.score ?? 1;
  const testSet = new Set(index.testFiles);
  // Tests are evidence, not the place to change: rank them below matching source code.
  for (const h of hits) direct.set(h.file, { score: 10 * (h.score / top) * (testSet.has(h.file) ? 0.6 : 1), why: [`matches ${h.matched.join(', ')} (${h.reasons[0] ?? ''})`] });
  for (const s of o.seeds ?? []) {
    if (!files.has(s)) continue;
    const d = direct.get(s);
    direct.set(s, { score: Math.max(10, (d?.score ?? 0) + 3), why: [...(d?.why ?? []), 'named by researcher'] });
  }
  const seeds = [...direct.keys()];
  const rel = (file: string, score: number, why: string) => {
    if (!files.has(file)) return;
    const r = relScores.get(file) ?? { best: 0, n: 0, why: [] };
    r.best = Math.max(r.best, score);
    r.n++;
    if (r.why.length < 3 && !r.why.includes(why)) r.why.push(why);
    relScores.set(file, r);
  };
  for (const s of seeds) {
    const w = direct.get(s)!.score;
    for (const d of dependents(index, [s], 2)) rel(d, 0.45 * w, `imports ${s}`);
    for (const dep of index.imports[s] ?? []) rel(dep, 0.3 * w, `used by ${s}`);
  }
  for (const n of dataNeighbours(index, seeds)) for (const f of n.files) rel(f, 4.5, `shares table "${n.table}"`);
  const tests = affectedTests(index, seeds);
  for (const t of tests) rel(t, 2.5, 'tests related code');
  const scores = new Map<string, ContextFile>();
  for (const f of new Set([...direct.keys(), ...relScores.keys()])) {
    const d = direct.get(f);
    const r = relScores.get(f);
    scores.set(f, { file: f, score: (d?.score ?? 0) + (r ? r.best + Math.min(2, 0.2 * (r.n - 1)) : 0), why: [...(d?.why ?? []), ...(r?.why ?? [])].slice(0, 4) });
  }

  const ranked = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, o.limit ?? 60);
  const inCtx = new Set(ranked.map((f) => f.file));
  const tableRows = index.tables
    .map((t) => {
      const usedBy = [...new Set([...(index.tableUsers[tableKey(t.name)] ?? []), ...(t.alias ? (index.tableUsers[tableKey(t.alias)] ?? []) : [])])].filter((f) => f !== t.file);
      return { name: t.name, columns: t.columns, definedIn: t.file, usedBy };
    })
    .filter((t) => inCtx.has(t.definedIn) || t.usedBy.some((f) => inCtx.has(f)));
  return {
    commit: index.commit,
    terms: [...new Set(o.terms.flatMap(tokenize))],
    files: ranked,
    endpoints: index.api.filter((a) => inCtx.has(a.file)).map(({ method, path, file }) => ({ method, path, file })),
    pages: index.pages.filter((p) => inCtx.has(p.file)).map(({ path, file }) => ({ path, file })),
    tables: tableRows,
    tests: tests.slice(0, 40),
    env: [...new Set([...inCtx].flatMap((f) => index.facts[f]?.envVars ?? []))].sort(),
    integrations: Object.entries(index.integrations).filter(([, fs]) => fs.some((f) => inCtx.has(f))).map(([k]) => k),
  };
}

export function formatContext(c: TaskContext, maxFiles = 40): string {
  const lines = [`Commit ${c.commit.slice(0, 10)} · terms: ${c.terms.join(', ') || '-'}`];
  lines.push('Files (ranked, with why they matter):');
  for (const f of c.files.slice(0, maxFiles)) lines.push(`- ${f.file} — ${f.why.join('; ')}`);
  if (c.endpoints.length) lines.push('Endpoints:', ...c.endpoints.map((e) => `- ${e.method} ${e.path} (${e.file})`));
  if (c.pages.length) lines.push('UI routes:', ...c.pages.map((p) => `- ${p.path} (${p.file})`));
  if (c.tables.length) lines.push('Tables:', ...c.tables.map((t) => `- ${t.name}(${t.columns.slice(0, 12).join(', ')}) in ${t.definedIn}${t.usedBy.length ? `; used by ${t.usedBy.slice(0, 8).join(', ')}` : ''}`));
  if (c.tests.length) lines.push(`Tests: ${c.tests.join(', ')}`);
  if (c.env.length) lines.push(`Env vars: ${c.env.join(', ')}`);
  if (c.integrations.length) lines.push(`Integrations: ${c.integrations.join(', ')}`);
  return lines.join('\n');
}
