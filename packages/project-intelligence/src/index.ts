import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { git } from '@devpilot/git-manager';
import { matchesAny } from '@devpilot/policy-engine';

/**
 * Project Intelligence Index (MVP).
 * Deterministic facts about the repo, bound to a commit so stale data is
 * never mistaken for the current structure:
 *  - file inventory, package manifests and scripts
 *  - JS/TS import graph (+ reverse graph)
 *  - source file -> test files that (transitively) import it
 */
export interface ProjectIndex {
  commit: string;
  builtAt: string;
  files: string[];
  packages: { path: string; name?: string; scripts: Record<string, string>; workspaces?: unknown }[];
  imports: Record<string, string[]>;
  importedBy: Record<string, string[]>;
  testFiles: string[];
  topLevelDirs: Record<string, number>;
}

const CODE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'];
const IMPORT_RX = /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;

function resolveImport(fromFile: string, spec: string, fileSet: Set<string>): string | undefined {
  if (!spec.startsWith('.')) return undefined; // external package / alias: not tracked in MVP
  const base = normalize(join(dirname(fromFile), spec));
  const stripped = base.replace(/\.(js|mjs|cjs)$/, '');
  const candidates = [
    base,
    ...CODE_EXT.map((e) => stripped + e),
    ...CODE_EXT.map((e) => join(base, 'index' + e)),
  ];
  return candidates.find((c) => fileSet.has(c));
}

export async function buildIndex(worktree: string, testGlobs: string[]): Promise<ProjectIndex> {
  const commit = await git(worktree, ['rev-parse', 'HEAD']);
  const files = (await git(worktree, ['ls-files'])).split('\n').filter(Boolean);
  const fileSet = new Set(files);
  const imports: Record<string, string[]> = {};
  const importedBy: Record<string, string[]> = {};
  const packages: ProjectIndex['packages'] = [];
  const topLevelDirs: Record<string, number> = {};

  for (const f of files) {
    const top = f.includes('/') ? f.split('/')[0]! : '.';
    topLevelDirs[top] = (topLevelDirs[top] ?? 0) + 1;
    const abs = join(worktree, f);
    if (f.endsWith('package.json')) {
      try {
        const pj = JSON.parse(readFileSync(abs, 'utf8'));
        packages.push({ path: f, name: pj.name, scripts: pj.scripts ?? {}, workspaces: pj.workspaces });
      } catch {
        /* ignore malformed */
      }
    }
    if (!CODE_EXT.includes(extname(f))) continue;
    if (!existsSync(abs) || statSync(abs).size > 1_000_000) continue;
    const src = readFileSync(abs, 'utf8');
    const deps = new Set<string>();
    for (const m of src.matchAll(IMPORT_RX)) {
      const r = resolveImport(f, m[1]!, fileSet);
      if (r) deps.add(r);
    }
    imports[f] = [...deps];
    for (const d of deps) (importedBy[d] ??= []).push(f);
  }
  const testFiles = files.filter((f) => matchesAny(f, testGlobs));
  return { commit, builtAt: new Date().toISOString(), files, packages, imports, importedBy, testFiles, topLevelDirs };
}

/** Everything that transitively imports any of `files` (reverse dependency closure). */
export function dependents(index: ProjectIndex, files: string[], maxDepth = 6): string[] {
  const seen = new Set<string>();
  let frontier = files.filter((f) => index.files.includes(f));
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const p of index.importedBy[f] ?? []) {
        if (!seen.has(p) && !files.includes(p)) {
          seen.add(p);
          next.push(p);
        }
      }
    }
    frontier = next;
  }
  return [...seen].sort();
}

export function affectedTests(index: ProjectIndex, files: string[]): string[] {
  const testSet = new Set(index.testFiles);
  const closure = new Set([...files, ...dependents(index, files)]);
  return [...closure].filter((f) => testSet.has(f)).sort();
}

/** Compact text summary that fits into an agent prompt. */
export function summarize(index: ProjectIndex, maxFiles = 400): string {
  const dirs = Object.entries(index.topLevelDirs)
    .sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `${d} (${n})`)
    .join(', ');
  const pkgs = index.packages
    .map((p) => `- ${p.path}${p.name ? ` [${p.name}]` : ''} scripts: ${Object.keys(p.scripts).join(', ') || '-'}`)
    .join('\n');
  const hubs = Object.entries(index.importedBy)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 15)
    .map(([f, by]) => `- ${f} <- ${by.length} importers`)
    .join('\n');
  const fileList = index.files.length > maxFiles ? index.files.slice(0, maxFiles).concat(`… (${index.files.length - maxFiles} more)`) : index.files;
  return [
    `Commit: ${index.commit}`,
    `Top-level: ${dirs}`,
    `Packages:\n${pkgs || '- none'}`,
    `Most-imported modules:\n${hubs || '- none'}`,
    `Test files: ${index.testFiles.length}`,
    `Files:\n${fileList.join('\n')}`,
  ].join('\n\n');
}
