import YAML from 'yaml';
import type { Declaration, FileFacts, ImportFact, RouteFact, TableFact } from './types';

type Facts = Omit<FileFacts, 'blob'>;

export const empty = (path: string, lang: FileFacts['lang']): Facts => ({
  path,
  lang,
  imports: [],
  declarations: [],
  routes: [],
  pages: [],
  envVars: [],
  testTitles: [],
  tables: [],
  tableRefs: [],
  urls: [],
});

const lineAt = (src: string, idx: number) => src.slice(0, idx).split('\n').length;

// ---------------------------------------------------------------- Python ----
export function parsePython(path: string, src: string): Facts {
  const f = empty(path, 'py');
  const lines = src.split('\n');
  const decls: Declaration[] = [];
  lines.forEach((l, i) => {
    let m = l.match(/^\s*from\s+([.\w]+)\s+import\s+\(?([^#)]+)/);
    if (m) f.imports.push({ spec: m[1]!, names: m[2]!.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]!).filter(Boolean), typeOnly: false, reexport: false, line: i + 1 } satisfies ImportFact);
    m = l.match(/^\s*import\s+([\w., ]+)/);
    if (m && !l.trim().startsWith('from')) for (const mod of m[1]!.split(',')) f.imports.push({ spec: mod.trim().split(/\s+as\s+/)[0]!, names: ['*'], typeOnly: false, reexport: false, line: i + 1 });
    m = l.match(/^(async\s+)?def\s+(\w+)|^class\s+(\w+)/);
    if (m) decls.push({ name: m[2] ?? m[3]!, kind: m[3] ? 'class' : 'function', exported: !(m[2] ?? m[3]!).startsWith('_'), startLine: i + 1, endLine: i + 1 });
    m = l.match(/^\s*(?:async\s+)?def\s+(test_\w+)/);
    if (m) f.testTitles.push(m[1]!);
    // FastAPI / Flask
    m = l.match(/^\s*@\w+\.(get|post|put|patch|delete|options|head)\(\s*["']([^"']+)/);
    if (m) f.routes.push({ method: m[1]!.toUpperCase(), path: m[2]!, line: i + 1, framework: 'fastapi' } satisfies RouteFact);
    m = l.match(/^\s*@\w+\.route\(\s*["']([^"']+)["'](?:.*methods\s*=\s*\[([^\]]+)\])?/);
    if (m) f.routes.push({ method: m[2] ? m[2].replace(/["'\s]/g, '').toUpperCase() : 'GET', path: m[1]!, line: i + 1, framework: 'flask' });
    for (const e of l.matchAll(/os\.(?:environ\.get|getenv|environ)\s*[\[(]\s*["'](\w+)["']/g)) f.envVars.push(e[1]!);
    m = l.match(/__tablename__\s*=\s*["'](\w+)["']/);
    if (m) f.tables.push({ name: m[1]!, alias: decls.filter((d) => d.kind === 'class').pop()?.name, columns: [], relations: [], source: 'sqlalchemy', line: i + 1 });
    m = l.match(/^class\s+(\w+)\(.*models\.Model.*\)/);
    if (m) f.tables.push({ name: m[1]!.toLowerCase(), alias: m[1], columns: [], relations: [], source: 'django', line: i + 1 });
    for (const q of l.matchAll(/\b(?:from|join|into|update)\s+["`]?([a-z_][a-z0-9_]*)["`]?/gi)) if (/select|insert|update|delete/i.test(l)) f.tableRefs.push(q[1]!.toLowerCase());
  });
  // close declaration ranges at the next top-level declaration
  decls.forEach((d, i) => (d.endLine = (decls[i + 1]?.startLine ?? lines.length + 1) - 1));
  f.declarations = decls;
  f.identifiers = [...new Set(src.match(/\b[A-Za-z_]\w{2,}\b/g) ?? [])].slice(0, 3000);
  f.envVars = [...new Set(f.envVars)].sort();
  f.tableRefs = [...new Set(f.tableRefs)].sort();
  return f;
}

// ---------------------------------------------------------------- Prisma ----
export function parsePrisma(path: string, src: string): Facts {
  const f = empty(path, 'prisma');
  const models = [...src.matchAll(/^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)];
  const names = new Set(models.map((m) => m[1]!));
  for (const m of models) {
    const body = m[2]!;
    const cols: string[] = [];
    const rel: string[] = [];
    for (const l of body.split('\n')) {
      const fm = l.match(/^\s*(\w+)\s+(\w+)(\[\])?\??/);
      if (!fm || fm[1]!.startsWith('@@')) continue;
      if (names.has(fm[2]!)) rel.push(fm[2]!);
      else cols.push(fm[1]!);
    }
    const mapped = body.match(/@@map\(\s*"(\w+)"\s*\)/)?.[1];
    f.tables.push({ name: mapped ?? m[1]!, alias: m[1], columns: cols, relations: [...new Set(rel)], source: 'prisma', line: lineAt(src, m.index!) });
  }
  for (const e of src.matchAll(/env\(\s*"(\w+)"\s*\)/g)) f.envVars.push(e[1]!);
  return f;
}

// ------------------------------------------------------------------- SQL ----
export function parseSql(path: string, src: string): Facts {
  const f = empty(path, 'sql');
  const byName = new Map<string, TableFact>();
  for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?(?:\w+\.)?(\w+)["`]?\s*\(([\s\S]*?)\);/gi)) {
    const cols: string[] = [];
    const rel: string[] = [];
    for (const l of m[2]!.split('\n')) {
      const c = l.trim().match(/^["`]?(\w+)["`]?\s+\w+/);
      if (c && !/^(primary|unique|constraint|foreign|check|index|key)$/i.test(c[1]!)) cols.push(c[1]!);
      const r = l.match(/references\s+["`]?(\w+)/i);
      if (r) rel.push(r[1]!);
    }
    const t: TableFact = { name: m[1]!.toLowerCase(), columns: cols, relations: rel, source: 'sql', line: lineAt(src, m.index!) };
    byName.set(t.name, t);
  }
  for (const m of src.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?["`]?(?:\w+\.)?(\w+)["`]?\s+add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?["`]?(\w+)/gi)) {
    const name = m[1]!.toLowerCase();
    const t = byName.get(name) ?? { name, columns: [], relations: [], source: 'sql' as const, line: lineAt(src, m.index!) };
    t.columns.push(m[2]!);
    byName.set(name, t);
  }
  f.tables = [...byName.values()];
  for (const m of src.matchAll(/\b(?:from|join|into|update)\s+["`]?(?:\w+\.)?([a-z_][a-z0-9_]*)/gi)) f.tableRefs.push(m[1]!.toLowerCase());
  f.tableRefs = [...new Set(f.tableRefs)].sort();
  return f;
}

// ------------------------------------------------- CI workflows / env files ----
export function parseWorkflow(path: string, src: string): Facts {
  const f = empty(path, 'yaml');
  try {
    const doc = YAML.parse(src) as { jobs?: Record<string, { steps?: { run?: string; uses?: string; name?: string }[] }> };
    f.ci = Object.entries(doc?.jobs ?? {}).map(([job, j]) => ({
      job,
      run: (j?.steps ?? []).map((s) => s.run ?? (s.uses ? `uses: ${s.uses}` : '')).filter(Boolean),
    }));
    for (const m of src.matchAll(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g)) f.envVars.push(m[1]!);
    f.envVars = [...new Set(f.envVars)].sort();
  } catch (e: any) {
    f.parseError = e.message;
  }
  return f;
}

export function parseEnvFile(path: string, src: string): Facts {
  const f = empty(path, 'other');
  f.envKeys = src
    .split('\n')
    .map((l) => l.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/)?.[1])
    .filter((x): x is string => !!x);
  return f;
}
