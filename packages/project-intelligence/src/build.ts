import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, join, posix } from 'node:path';
import { promisify } from 'node:util';
import ts from 'ts-parser';
import YAML from 'yaml';
import { matchesAny } from '@devpilot/policy-engine';
import { parseTs } from './parse-ts';
import { empty, parseEnvFile, parsePrisma, parsePython, parseSql, parseWorkflow } from './parse-other';
import { INDEX_VERSION, type FileFacts, type ProjectIndex, type WorkspacePackage } from './types';

const pexec = promisify(execFile);
const git = async (cwd: string, args: string[], input?: string) => {
  if (input === undefined) return (await pexec('git', args, { cwd, maxBuffer: 256 * 1024 * 1024 })).stdout;
  return await new Promise<string>((res, rej) => {
    const p = execFile('git', args, { cwd, maxBuffer: 256 * 1024 * 1024 }, (e, out) => (e ? rej(e) : res(out)));
    p.stdin!.end(input);
  });
};

const JS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const MAX_BYTES = 1_000_000;
const SKIP = [/(^|\/)(node_modules|dist|build|\.next|coverage|vendor)\//, /\.min\.js$/, /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/];
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const PY_STDLIB = new Set(['os', 'sys', 're', 'json', 'typing', 'datetime', 'time', 'math', 'collections', 'itertools', 'functools', 'pathlib', 'logging', 'asyncio', 'subprocess', 'unittest', 'dataclasses', 'enum', 'abc', 'uuid', 'random', 'decimal', 'hashlib', 'base64', 'io', 'copy', 'contextlib', 'tempfile', 'shutil', 'argparse', '__future__']);

/** Known SDKs -> integration label. Anything else external is still listed in `externals`. */
const INTEGRATIONS: [RegExp, string][] = [
  [/^stripe$|^@stripe\//, 'Stripe (payments)'],
  [/^@paypal\//, 'PayPal (payments)'],
  [/^(yookassa|@a2seven\/yoo-checkout)/, 'YooKassa (payments)'],
  [/^@aws-sdk\/|^aws-sdk$/, 'AWS'],
  [/^@google-cloud\/|^googleapis$/, 'Google Cloud'],
  [/^firebase(-admin)?$/, 'Firebase'],
  [/^@supabase\//, 'Supabase'],
  [/^twilio$/, 'Twilio (SMS/voice)'],
  [/^@sendgrid\/|^nodemailer$|^resend$|^postmark$|^mailgun/, 'Email delivery'],
  [/^(telegraf|grammy|node-telegram-bot-api)$/, 'Telegram bot'],
  [/^@slack\//, 'Slack'],
  [/^openai$|^@anthropic-ai\/|^@google\/generative-ai$/, 'LLM API'],
  [/^(kafkajs|amqplib|bullmq|bull|@aws-sdk\/client-sqs|nats)$/, 'Message queue'],
  [/^(ioredis|redis)$/, 'Redis'],
  [/^(pg|postgres|mysql2|mysql|mongodb|mongoose|better-sqlite3|sqlite3|@prisma\/client|drizzle-orm|typeorm|knex|sequelize)$/, 'Database client'],
  [/^@sentry\//, 'Sentry (errors)'],
  [/^(posthog-js|posthog-node|mixpanel|@segment\/|@amplitude\/)/, 'Product analytics'],
  [/^(next-auth|@auth\/|passport|@clerk\/|@auth0\/|jsonwebtoken|jose)/, 'Auth'],
  [/^(axios|got|node-fetch|undici|ky)$/, 'HTTP client'],
  [/^(socket\.io|ws)$/, 'WebSocket'],
  [/^(@opentelemetry\/)/, 'OpenTelemetry'],
];

function langOf(path: string): FileFacts['lang'] | undefined {
  const ext = extname(path);
  if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) return 'ts';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'js';
  if (ext === '.py') return 'py';
  if (ext === '.prisma') return 'prisma';
  if (ext === '.sql') return 'sql';
  if (/(^|\/)\.github\/workflows\/.+\.ya?ml$/.test(path)) return 'yaml';
  if (/(^|\/)\.env(\.[\w-]+)?$/.test(path) && /example|sample|template|defaults/.test(path)) return 'other';
  return undefined;
}

function parseFile(path: string, src: string, lang: FileFacts['lang']): Omit<FileFacts, 'blob'> {
  try {
    if (lang === 'ts' || lang === 'js') return parseTs(path, src, lang);
    if (lang === 'py') return parsePython(path, src);
    if (lang === 'prisma') return parsePrisma(path, src);
    if (lang === 'sql') return parseSql(path, src);
    if (lang === 'yaml') return parseWorkflow(path, src);
    return parseEnvFile(path, src);
  } catch (e: any) {
    return { ...empty(path, lang), parseError: e?.message ?? String(e) };
  }
}

/** Files at the worktree state (tracked + untracked-not-ignored) with their blob hashes. */
async function listFiles(worktree: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const rec of (await git(worktree, ['ls-files', '-s', '-z'])).split('\0').filter(Boolean)) {
    const [meta, path] = rec.split('\t') as [string, string];
    out.set(path, meta.split(' ')[1]!);
  }
  const dirty = (await git(worktree, ['ls-files', '-m', '-o', '--exclude-standard', '-z'])).split('\0').filter(Boolean).filter((p) => existsSync(join(worktree, p)));
  if (dirty.length) {
    const hashes = (await git(worktree, ['hash-object', '--stdin-paths'], dirty.join('\n') + '\n')).trim().split('\n');
    dirty.forEach((p, i) => out.set(p, hashes[i]!));
  }
  for (const p of [...out.keys()]) if (!existsSync(join(worktree, p))) out.delete(p);
  return out;
}

// --------------------------------------------------------------- resolution ----
interface Resolver {
  resolve(from: string, spec: string, lang: FileFacts['lang']): { file?: string; external?: string };
}

function readJson(path: string): any {
  try {
    const r = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
    return r.config ?? {};
  } catch {
    return {};
  }
}

function workspacePackages(worktree: string, files: Set<string>): WorkspacePackage[] {
  const root = existsSync(join(worktree, 'package.json')) ? readJson(join(worktree, 'package.json')) : {};
  let globs: string[] = Array.isArray(root.workspaces) ? root.workspaces : (root.workspaces?.packages ?? []);
  if (existsSync(join(worktree, 'pnpm-workspace.yaml'))) {
    try {
      globs = globs.concat((YAML.parse(readFileSync(join(worktree, 'pnpm-workspace.yaml'), 'utf8'))?.packages ?? []) as string[]);
    } catch {
      /* ignore */
    }
  }
  const pkgFiles = [...files].filter((f) => f.endsWith('package.json') && !f.includes('node_modules/'));
  const out: WorkspacePackage[] = [];
  for (const pf of pkgFiles) {
    const dir = posix.dirname(pf) === '.' ? '' : posix.dirname(pf);
    if (dir && globs.length && !matchesAny(dir, globs)) continue;
    const pj = readJson(join(worktree, pf));
    if (!pj.name) continue;
    const exp = pj.exports?.['.'] ?? pj.exports;
    const entry = typeof exp === 'string' ? exp : (exp?.import ?? exp?.default ?? exp?.types ?? pj.module ?? pj.main);
    out.push({ name: pj.name, dir, entry: typeof entry === 'string' ? posix.normalize(posix.join(dir, entry)) : undefined, scripts: pj.scripts ?? {} });
  }
  return out;
}

function makeResolver(worktree: string, files: Set<string>, packages: WorkspacePackage[]): Resolver {
  const tsconfig = existsSync(join(worktree, 'tsconfig.json')) ? readJson(join(worktree, 'tsconfig.json')) : {};
  const baseUrl: string = tsconfig.compilerOptions?.baseUrl ?? '.';
  const paths: Record<string, string[]> = tsconfig.compilerOptions?.paths ?? {};
  const pyRoots = ['', 'src/', ...new Set([...files].filter((f) => f.endsWith('/__init__.py')).map((f) => f.split('/')[0] + '/'))];

  const tryJs = (base: string): string | undefined => {
    const b = posix.normalize(base).replace(/^\.\//, '');
    const stripped = b.replace(/\.(m|c)?js$/, '');
    const cands = [b, ...JS_EXT.map((e) => stripped + e), ...JS_EXT.map((e) => posix.join(b, 'index' + e))];
    return cands.find((c) => files.has(c));
  };
  const pkgName = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);

  return {
    resolve(from, spec, lang) {
      if (lang === 'py') {
        if (spec.startsWith('.')) {
          const ups = spec.match(/^\.+/)![0].length;
          let dir = posix.dirname(from);
          for (let i = 1; i < ups; i++) dir = posix.dirname(dir);
          const rest = spec.slice(ups).replace(/\./g, '/');
          const base = rest ? posix.join(dir, rest) : dir;
          const f = [`${base}.py`, `${base}/__init__.py`].map((p) => p.replace(/^\.\//, '')).find((c) => files.has(c));
          return f ? { file: f } : {};
        }
        const rel = spec.replace(/\./g, '/');
        for (const r of pyRoots) {
          const f = [`${r}${rel}.py`, `${r}${rel}/__init__.py`].find((c) => files.has(c));
          if (f) return { file: f };
        }
        const top = spec.split('.')[0]!;
        return PY_STDLIB.has(top) ? {} : { external: top };
      }
      if (spec.startsWith('.')) return { file: tryJs(posix.join(posix.dirname(from), spec)) };
      if (BUILTINS.has(spec) || spec.startsWith('node:')) return {};
      for (const [pattern, targets] of Object.entries(paths)) {
        const star = pattern.indexOf('*');
        const prefix = star >= 0 ? pattern.slice(0, star) : pattern;
        if (star >= 0 ? spec.startsWith(prefix) : spec === pattern) {
          const rest = star >= 0 ? spec.slice(prefix.length) : '';
          for (const t of targets) {
            const f = tryJs(posix.join(baseUrl, t.replace('*', rest)));
            if (f) return { file: f };
          }
        }
      }
      const pkg = packages.find((p) => spec === p.name || spec.startsWith(p.name + '/'));
      if (pkg) {
        const sub = spec.slice(pkg.name.length + 1);
        const f = sub
          ? (tryJs(posix.join(pkg.dir, sub)) ?? tryJs(posix.join(pkg.dir, 'src', sub)))
          : ((pkg.entry && (files.has(pkg.entry) ? pkg.entry : tryJs(pkg.entry))) ?? tryJs(posix.join(pkg.dir, 'src/index')) ?? tryJs(posix.join(pkg.dir, 'index')));
        if (f) return { file: f };
      }
      if (baseUrl !== '.' || tsconfig.compilerOptions?.baseUrl) {
        const f = tryJs(posix.join(baseUrl, spec));
        if (f) return { file: f };
      }
      return { external: pkgName(spec) };
    },
  };
}

// ------------------------------------------------------------------ build ----
/** Normalised key so `Booking` (model), `bookings` (table) and `booking` (prisma.booking) meet. */
export function tableKey(name: string): string {
  let k = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (k.endsWith('ies')) k = k.slice(0, -3) + 'y';
  else if (/(ses|xes|zes|ches|shes)$/.test(k)) k = k.slice(0, -2);
  else if (k.endsWith('s') && !k.endsWith('ss')) k = k.slice(0, -1);
  return k;
}

const push = (m: Record<string, string[]>, k: string, v: string) => {
  const a = (m[k] ??= []);
  if (!a.includes(v)) a.push(v);
};

export interface BuildOptions {
  testGlobs: string[];
  /** Directory for the per-blob facts cache. Without it every build parses everything. */
  cacheDir?: string;
}

export async function buildIndex(worktree: string, opts: BuildOptions): Promise<ProjectIndex> {
  const t0 = Date.now();
  const commit = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
  const listed = await listFiles(worktree);
  const all = [...listed.keys()].filter((p) => !SKIP.some((rx) => rx.test(p))).sort();
  const fileSet = new Set(all);

  const cachePath = opts.cacheDir ? join(opts.cacheDir, `facts-v${INDEX_VERSION}.json`) : undefined;
  const cache: Record<string, FileFacts> = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
  const facts: Record<string, FileFacts> = {};
  let parsed = 0;
  let reused = 0;
  for (const p of all) {
    const lang = langOf(p);
    if (!lang) continue;
    const blob = listed.get(p)!;
    const key = `${blob}:${p}`;
    if (cache[key]) {
      facts[p] = cache[key]!;
      reused++;
      continue;
    }
    const abs = join(worktree, p);
    if (statSync(abs).size > MAX_BYTES) continue;
    facts[p] = { ...parseFile(p, readFileSync(abs, 'utf8'), lang), blob };
    parsed++;
  }
  if (cachePath) {
    mkdirSync(dirname(cachePath), { recursive: true });
    const next = Object.fromEntries(Object.values(facts).map((f) => [`${f.blob}:${f.path}`, f]));
    writeFileSync(cachePath + '.tmp', JSON.stringify(next));
    renameSync(cachePath + '.tmp', cachePath);
  }

  const packages = workspacePackages(worktree, fileSet);
  const resolver = makeResolver(worktree, fileSet, packages);
  const imports: Record<string, string[]> = {};
  const importedBy: Record<string, string[]> = {};
  const symbolUsers: Record<string, string[]> = {};
  const externals: Record<string, string[]> = {};
  const integrations: Record<string, string[]> = {};
  const api: ProjectIndex['api'] = [];
  const pages: ProjectIndex['pages'] = [];
  const tables: ProjectIndex['tables'] = [];
  const tableUsers: Record<string, string[]> = {};
  const env: Record<string, string[]> = {};
  const ci: ProjectIndex['ci'] = [];

  for (const f of Object.values(facts)) {
    for (const im of f.imports) {
      // Python `from . import mod` — names may be submodules
      const targets: { file?: string; external?: string; names: string[] }[] = [];
      const r = resolver.resolve(f.path, im.spec, f.lang);
      if (r.file || r.external) targets.push({ ...r, names: im.names });
      if (f.lang === 'py' && !r.file) for (const n of im.names) {
        const sub = resolver.resolve(f.path, im.spec.endsWith('.') ? im.spec + n : `${im.spec}.${n}`, 'py');
        if (sub.file) targets.push({ file: sub.file, names: ['*'] });
      }
      for (const t of targets) {
        if (t.file && t.file !== f.path) {
          push(imports, f.path, t.file);
          push(importedBy, t.file, f.path);
          for (const n of t.names) push(symbolUsers, `${t.file}#${n}`, f.path);
        } else if (t.external) {
          push(externals, t.external, f.path);
          const label = INTEGRATIONS.find(([rx]) => rx.test(t.external!))?.[1];
          if (label) push(integrations, label, f.path);
        }
      }
    }
    for (const u of f.urls) push(integrations, `HTTP ${u}`, f.path);
    for (const r of f.routes) api.push({ ...r, file: f.path });
    for (const pg of f.pages) pages.push({ ...pg, file: f.path });
    for (const t of f.tables) {
      tables.push({ ...t, file: f.path });
      push(tableUsers, tableKey(t.name), f.path);
      if (t.alias) push(tableUsers, tableKey(t.alias), f.path);
    }
    for (const ref of f.tableRefs) push(tableUsers, tableKey(ref), f.path);
    for (const v of f.envVars) push(env, v, f.path);
    for (const k of f.envKeys ?? []) push(env, k, f.path);
    if (f.ci) ci.push({ file: f.path, jobs: f.ci });
  }
  // Only keep table keys that correspond to a known table/model (filters SQL noise like "set").
  const known = new Set(tables.flatMap((t) => [tableKey(t.name), t.alias ? tableKey(t.alias) : '']).filter(Boolean));
  for (const k of Object.keys(tableUsers)) if (!known.has(k)) delete tableUsers[k];

  const testFiles = all.filter((f) => matchesAny(f, opts.testGlobs) || Boolean(facts[f]?.testTitles.length && /test|spec/i.test(f)));
  const testsFor: Record<string, string[]> = {};
  for (const t of testFiles) {
    const seen = new Set<string>([t]);
    let frontier = [t];
    for (let d = 0; d < 8 && frontier.length; d++) {
      const next: string[] = [];
      for (const f of frontier) for (const dep of imports[f] ?? []) if (!seen.has(dep)) (seen.add(dep), next.push(dep));
      frontier = next;
    }
    for (const s of seen) if (s !== t) push(testsFor, s, t);
  }

  return {
    version: INDEX_VERSION,
    commit,
    builtAt: new Date().toISOString(),
    files: all,
    facts,
    packages,
    imports,
    importedBy,
    symbolUsers,
    externals,
    testFiles,
    testsFor,
    api,
    pages,
    tables,
    tableUsers,
    env,
    ci,
    integrations,
    stats: { files: all.length, parsed, reused, ms: Date.now() - t0 },
  };
}

