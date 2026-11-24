// Review eval: does the independent reviewer catch bugs that the tests miss, and does it leave
// a correct change alone? Each case = reference implementation (+ one seeded bug), with the
// hidden tests that would catch that bug removed, so every gate is green — exactly the situation
// review exists for. Usage:
//   npx tsx scripts/review-eval.ts <reference-dir> [configs] [concurrency]
//   configs: comma list of model:effort:calibrated, e.g. opus-5-5:high:0,opus-5-5:high:1,sonnet-5-5:medium:1
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { ClaudeCliRunner, ReviewOutput } from '@devpilot/agent-runtime';
import { loadPolicy } from '@devpilot/policy-engine';
import { AGENTS_DIR, ROOT } from '@devpilot/orchestrator';
import { BENCH_POLICY } from '@devpilot/benchmark';
import { reviewerPrompt } from '../packages/orchestrator/src/prompts';
import type { Task } from '@devpilot/shared';

const [refDir, cfgArg = 'claude-opus-5-5:high:0,claude-opus-5-5:high:1,claude-sonnet-5-5:medium:1', conc = '4'] = process.argv.slice(2);
if (!refDir) throw new Error('usage: review-eval.ts <reference-dir> [configs] [concurrency]');
const BENCH = join(ROOT, 'benchmarks', 'library-platform');
const prompt = String(YAML.parse(readFileSync(join(BENCH, 'benchmark.yaml'), 'utf8')).prompt);

interface Case {
  name: string;
  /** [from, to] replacements in src/http/server.js */
  mutate: [string, string][];
  /** hidden tests (by name) that would catch the bug: removed so all gates stay green */
  drop: string[];
  /** a blocking finding counts as a catch only if it is about the bug */
  about?: RegExp;
}
const CASES: Case[] = [
  { name: 'clean-1', mutate: [], drop: [] },
  { name: 'clean-2', mutate: [], drop: [] },
  { name: 'renew-ignores-queue', mutate: [["      if (queue(loan.bookId).length) throw err(409, 'someone is waiting for this book');\n", '']], drop: ['renewal refused', 'renewal allowed again'], about: /renew/i },
  { name: 'fine-not-capped', mutate: [['Math.min(1000, 25 * Math.ceil(late / D))', '25 * Math.ceil(late / D)']], drop: ['capped at 1000'], about: /cap|1000|maximum|max/i },
  { name: 'payment-newest-first', mutate: [["for (const f of where(db, 'fines', (x) => x.memberId === p[0] && !x.paid)) {", "for (const f of where(db, 'fines', (x) => x.memberId === p[0] && !x.paid).reverse()) {"]], drop: ['payments: oldest first'], about: /oldest|order|newest|first/i },
  { name: 'expiry-off-by-boundary', mutate: [['now.getTime() >= Date.parse(x.expiresAt)', 'now.getTime() > Date.parse(x.expiresAt)']], drop: ['exactly 48h', 'system events'], about: /expir|boundary|>=|48/i },
  { name: 'fines-dont-block-reserve', mutate: [["      const m = member(b.memberId);\n      blocked(m.id);\n      if (available(p[0]) > 0)", "      const m = member(b.memberId);\n      if (available(p[0]) > 0)"]], drop: ['blocks borrowing and reserving'], about: /reserv/i },
  { name: 'audit-next-when-exact', mutate: [['next: items.length > limit ? page[page.length - 1].seq : null', 'next: page.length === limit ? page[page.length - 1].seq : null']], drop: [], about: /next|paginat/i },
];

const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
function dropTests(src: string, names: string[]): string {
  if (!names.length) return src;
  const parts = src.split('\ntest(');
  return [parts[0], ...parts.slice(1).filter((p) => !names.some((n) => p.slice(0, 200).includes(n)))].join('\ntest(');
}

function build(c: Case): { repo: string; diff: string } {
  const root = mkdtempSync(join(tmpdir(), `review-eval-${c.name}-`));
  const repo = join(root, 'repo');
  cpSync(join(BENCH, 'repo'), repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'add', '-A');
  sh(repo, '-c', 'user.email=e@e', '-c', 'user.name=e', 'commit', '-qm', 'base');
  // the change: reference implementation (+ the seeded bug) and its tests
  cpSync(join(refDir!, 'src'), join(repo, 'src'), { recursive: true });
  let server = readFileSync(join(repo, 'src/http/server.js'), 'utf8');
  for (const [from, to] of c.mutate) {
    if (!server.includes(from)) throw new Error(`${c.name}: mutation does not apply: ${from.slice(0, 60)}`);
    server = server.replace(from, to);
  }
  writeFileSync(join(repo, 'src/http/server.js'), server.replace('// Reference implementation (validation of hidden tests only). Self-contained on purpose.\n', ''));
  for (const f of readdirSync(join(BENCH, 'acceptance'))) writeFileSync(join(repo, 'tests', f), dropTests(readFileSync(join(BENCH, 'acceptance', f), 'utf8'), c.drop));
  execFileSync('node', ['--test'], { cwd: repo, stdio: 'pipe' }); // every remaining test must pass
  sh(repo, 'add', '-A');
  sh(repo, '-c', 'user.email=e@e', '-c', 'user.name=e', 'commit', '-qm', 'change');
  return { repo, diff: sh(repo, 'diff', 'HEAD~1', 'HEAD') };
}

const REQS = [
  ['tiers: basic/premium limits and loan periods', 'tests/platform.test.js'],
  ['reservation queue with 48h holds, expiry, report', 'tests/reservations.test.js'],
  ['loan renewals with all refusal rules', 'tests/platform.test.js'],
  ['fines (25c per started day, cap 1000) and payments (oldest first), 403 block at >= 500', 'tests/platform.test.js'],
  ['audit log with system events, filters and pagination', 'tests/platform.test.js'],
  ['book search with q/author/available, ordering, pagination, X-Total-Count', 'tests/platform.test.js'],
].map(([d, t], i) => ({ id: `REQ-0${i + 1}`, description: d!, acceptanceCriteria: ['as specified in the request'], status: 'covered' as const, tests: [t!] }));

const policyPath = join(mkdtempSync(join(tmpdir(), 'review-eval-pol-')), 'devpilot.yaml');
writeFileSync(policyPath, BENCH_POLICY);
const runner = new ClaudeCliRunner({ policy: loadPolicy(policyPath), policyPath, agentsDir: AGENTS_DIR });

const configs = (cfgArg === 'none' ? [] : cfgArg.split(',')).map((c) => {
  const [model, effort, cal] = c.split(':');
  return { model: model!, effort: effort as 'medium', calibrated: cal !== '0', label: `${model!.replace('claude-', '')}/${effort}/${cal !== '0' ? 'calibrated' : 'old'}` };
});
// ONLY=clean-1,clean-2 limits the run to some cases; CLEAN=N adds extra clean repetitions
const extra = Array.from({ length: Number(process.env.CLEAN ?? 0) }, (_, i) => ({ name: `clean-${3 + i}`, mutate: [], drop: [] }) as Case);
CASES.push(...extra);
if (process.env.ONLY) CASES.splice(0, CASES.length, ...CASES.filter((c) => process.env.ONLY!.split(',').some((o) => c.name.startsWith(o))));
const built = new Map(CASES.map((c) => [c.name, build(c)]));
console.log(`built ${built.size} cases (all remaining tests green in each)`);

const jobs = configs.flatMap((cfg) => CASES.map((c) => ({ cfg, c })));
const rows: { cfg: string; case: string; blocked: boolean; caught: boolean; blocking: string[]; cost: number; secs: number; error?: string }[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Number(conc) }, async () => {
    while (next < jobs.length) {
      const { cfg, c } = jobs[next++]!;
      const { repo, diff } = built.get(c.name)!;
      const head = sh(repo, 'rev-parse', 'HEAD');
      const passed = (name: string, reason: string) => ({ name, commit: head, required: true, status: 'passed', reason, ranAt: new Date().toISOString() });
      const gates = Object.fromEntries(
        [passed('diff_present', 'changes present'), passed('test_integrity', 'no tests removed or skipped'), passed('secrets_scan', 'no secrets'), passed('typecheck', 'node --check'), passed('lint', 'npm run lint'), passed('unit_tests', 'npm test'), passed('requirements_coverage', 'all requirements mapped to passing tests')].map((g) => [g.name, g]),
      );
      const task = { id: `EVAL-${c.name}`, prompt, requirements: REQS, gates, baseCommit: sh(repo, 'rev-parse', 'HEAD~1'), humanInput: [], assumptions: [] } as unknown as Task;
      const t0 = Date.now();
      const r = await runner.run({ role: 'reviewer', taskId: task.id, prompt: reviewerPrompt(task, diff, '', { calibrated: cfg.calibrated }), cwd: repo, schema: ReviewOutput, model: cfg.model, effort: cfg.effort, maxTurns: 40, budgetUsd: 5, timeoutMs: 20 * 60_000 });
      const out = r.output;
      const blocking = (out?.findings ?? []).filter((f) => f.severity === 'blocker' || f.severity === 'major').map((f) => `${f.title} — ${f.description}`.slice(0, 300));
      const unmet = out?.unmetRequirements ?? [];
      const blocked = blocking.length > 0 || unmet.length > 0;
      const caught = !!c.about && blocking.some((b) => c.about!.test(b));
      rows.push({ cfg: cfg.label, case: c.name, blocked, caught, blocking: [...blocking, ...unmet.map((u) => `unmet ${u}`)], cost: r.costUsd, secs: Math.round((Date.now() - t0) / 1000), error: r.ok ? undefined : r.error });
      console.log(`${cfg.label.padEnd(28)} ${c.name.padEnd(26)} ${blocked ? 'BLOCK' : 'pass '} ${c.about ? (caught ? 'caught' : 'MISSED') : blocked ? 'FALSE-BLOCK' : 'ok'}  $${r.costUsd.toFixed(2)} ${Math.round((Date.now() - t0) / 1000)}s${r.ok ? '' : ' ERROR ' + r.error}`);
    }
  }),
);

const out: string[] = ['# Review eval', '', '| Config | Bugs caught | Clean blocked (false alarms) | Avg cost | Avg time |', '|---|---|---|---|---|'];
for (const cfg of configs) {
  const rs = rows.filter((r) => r.cfg === cfg.label);
  const bugs = rs.filter((r) => CASES.find((c) => c.name === r.case)!.about);
  const clean = rs.filter((r) => !CASES.find((c) => c.name === r.case)!.about);
  out.push(`| ${cfg.label} | ${bugs.filter((r) => r.caught).length}/${bugs.length} | ${clean.filter((r) => r.blocked).length}/${clean.length} | $${(rs.reduce((s, r) => s + r.cost, 0) / rs.length).toFixed(2)} | ${Math.round(rs.reduce((s, r) => s + r.secs, 0) / rs.length)}s |`);
}
out.push('', '## Details', '');
for (const r of rows.sort((a, b) => a.cfg.localeCompare(b.cfg) || a.case.localeCompare(b.case))) out.push(`- **${r.cfg}** ${r.case}: ${r.blocked ? 'BLOCK' : 'pass'}${r.blocking.length ? '\n  - ' + r.blocking.join('\n  - ') : ''}`);
const dir = join(process.env.DEVPILOT_DATA_DIR ?? '.devpilot', 'review-eval');
mkdirSync(dir, { recursive: true });
const file = join(dir, `review-eval-${Date.now()}.md`);
writeFileSync(file, out.join('\n'));
console.log('\n' + out.slice(0, 3 + configs.length).join('\n') + `\n\nReport: ${file}`);
