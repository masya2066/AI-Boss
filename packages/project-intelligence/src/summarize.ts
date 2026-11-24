import type { ProjectIndex } from './types';

/** Architecture map that fits into an agent prompt. Deterministic and commit-bound. */
export function summarize(index: ProjectIndex, o: { maxFiles?: number } = {}): string {
  const maxFiles = o.maxFiles ?? 300;
  const top: Record<string, number> = {};
  for (const f of index.files) {
    const k = f.includes('/') ? f.split('/')[0]! : '.';
    top[k] = (top[k] ?? 0) + 1;
  }
  const L: string[] = [`Commit ${index.commit} · ${index.files.length} files · ${index.testFiles.length} test files`];
  L.push(`Top-level: ${Object.entries(top).sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d} (${n})`).join(', ')}`);
  if (index.packages.length) L.push('Packages:', ...index.packages.map((p) => `- ${p.name} @ ${p.dir || '.'}${p.entry ? ` entry ${p.entry}` : ''}; scripts: ${Object.keys(p.scripts).join(', ') || '-'}`));
  if (index.api.length) L.push(`API endpoints (${index.api.length}):`, ...index.api.slice(0, 80).map((a) => `- ${a.method} ${a.path} — ${a.file}:${a.line} [${a.framework}]`));
  if (index.pages.length) L.push(`UI routes (${index.pages.length}):`, ...index.pages.slice(0, 50).map((p) => `- ${p.path} — ${p.file}`));
  if (index.tables.length) L.push(`Data model (${index.tables.length}):`, ...index.tables.slice(0, 50).map((t) => `- ${t.name}${t.alias && t.alias !== t.name ? ` (${t.alias})` : ''}: ${t.columns.slice(0, 14).join(', ')}${t.relations.length ? ` → ${t.relations.join(', ')}` : ''} [${t.source} ${t.file}]`));
  const integ = Object.entries(index.integrations);
  if (integ.length) L.push('Integrations:', ...integ.map(([k, fs]) => `- ${k}: ${fs.slice(0, 5).join(', ')}${fs.length > 5 ? ` (+${fs.length - 5})` : ''}`));
  const env = Object.keys(index.env);
  if (env.length) L.push(`Env vars: ${env.sort().join(', ')}`);
  if (index.ci.length) L.push('CI:', ...index.ci.flatMap((c) => c.jobs.map((j) => `- ${c.file} / ${j.job}: ${j.run.filter((r) => !r.startsWith('uses:')).join(' && ').slice(0, 200)}`)));
  const hubs = Object.entries(index.importedBy).sort((a, b) => b[1].length - a[1].length).slice(0, 15);
  if (hubs.length) L.push('Most-imported modules:', ...hubs.map(([f, by]) => `- ${f} <- ${by.length}`));
  const fl = index.files.length > maxFiles ? [...index.files.slice(0, maxFiles), `… (${index.files.length - maxFiles} more)`] : index.files;
  L.push('Files:', ...fl);
  return L.join('\n');
}
