import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { MemoryStore } from '@devpilot/database';
import { Orchestrator } from '@devpilot/orchestrator';
import type { AgentRunner } from '@devpilot/agent-runtime';
import { LocalExecutor, scrubbedEnv } from '@devpilot/sandbox-manager';

/**
 * Control tasks (section 11): the same task is solved by DevPilot and by a plain,
 * single Claude Code session; both results are judged by the SAME hidden acceptance
 * tests, which no agent ever sees (they are copied in after the run).
 */
export interface Benchmark {
  name: string;
  dir: string;
  prompt: string;
  acceptance: string;
  /** Extra project policy YAML merged over the benchmark default. */
  policy?: string;
}

export const BENCH_POLICY = `
project: { default_branch: main }
execution: { agent_sandbox: true }
commands:
  typecheck: "for f in src/*.js; do node --check $f || exit 1; done"
  unit_tests: "npm test"
quality:
  lint: off
  security_scan: off
  e2e_tests: off
  integration_tests: off
limits: { max_repair_attempts: 3, max_task_cost_usd: 10, gate_timeout_seconds: 120 }
delivery: { create_pr: false }
`;

export function loadBenchmarks(root: string, only?: string[]): Benchmark[] {
  return readdirSync(root)
    .filter((d) => existsSync(join(root, d, 'benchmark.yaml')) && (!only?.length || only.includes(d)))
    .sort()
    .map((d) => {
      const y = YAML.parse(readFileSync(join(root, d, 'benchmark.yaml'), 'utf8'));
      return { name: y.name ?? d, dir: join(root, d), prompt: String(y.prompt).trim(), acceptance: y.acceptance, policy: y.policy };
    });
}

export type BaselineRunner = (o: { cwd: string; prompt: string; timeoutMs: number }) => Promise<{ costUsd: number; ok: boolean; error?: string }>;

/** Plain Claude Code: one `claude -p` session, edits auto-accepted, no orchestration, no gates. */
export function claudeBaseline(o: { model?: string; claudeBin?: string } = {}): BaselineRunner {
  return ({ cwd, prompt, timeoutMs }) =>
    new Promise((resolve) => {
      const env = scrubbedEnv([], process.env.CLAUDE_CODE_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN } : {});
      const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write,Edit,MultiEdit,Bash,Glob,Grep', '--model', o.model ?? 'claude-opus-5-5'];
      const child = spawn(o.claudeBin ?? process.env.DEVPILOT_CLAUDE_BIN ?? 'claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (c: Buffer) => (out += c));
      child.stderr.on('data', (c: Buffer) => (err += c));
      child.stdin.end(prompt);
      const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('close', (code) => {
        clearTimeout(t);
        try {
          const r = JSON.parse(out.trim().split('\n').pop()!);
          resolve({ costUsd: r.total_cost_usd ?? 0, ok: !r.is_error, error: r.is_error ? String(r.result ?? r.subtype) : undefined });
        } catch {
          resolve({ costUsd: 0, ok: false, error: `exit ${code}: ${err.slice(-500)}` });
        }
      });
    });
}

export interface BenchResult {
  benchmark: string;
  mode: 'devpilot' | 'baseline';
  accepted: boolean;
  passed: number;
  failed: number;
  costUsd: number;
  minutes: number;
  taskState?: string;
  repairs?: number;
  humanInput?: number;
  error?: string;
  acceptanceLog: string;
}

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();

function freshRepo(b: Benchmark, root: string): string {
  const repo = join(root, 'repo');
  cpSync(join(b.dir, 'repo'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=bench@devpilot', '-c', 'user.name=bench', 'commit', '-qm', 'benchmark base');
  return repo;
}

async function judge(b: Benchmark, checkout: string) {
  // Hidden tests arrive only now; nothing the agents did can have seen them.
  cpSync(join(b.dir, 'acceptance'), join(checkout, 'acceptance'), { recursive: true });
  const r = await new LocalExecutor().run(b.acceptance, { cwd: checkout, timeoutMs: 180_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const num = (k: string) => Number(out.match(new RegExp(`(?:ℹ|#) ${k} (\\d+)`))?.[1] ?? 0);
  return { accepted: r.exitCode === 0, passed: num('pass'), failed: num('fail'), log: out.slice(-3000) };
}

export async function runBenchmarks(o: {
  benchmarks: Benchmark[];
  modes: ('devpilot' | 'baseline')[];
  runner: AgentRunner;
  baseline: BaselineRunner;
  outDir: string;
  policiesDir?: string;
  /** Answer approval requests automatically (benchmarks measure autonomy; answers are logged). */
  autoApprove?: string;
  log?: (l: string) => void;
}): Promise<{ results: BenchResult[]; reportPath: string }> {
  const log = o.log ?? (() => {});
  const results: BenchResult[] = [];
  for (const b of o.benchmarks) {
    for (const mode of o.modes) {
      const root = mkdtempSync(join(tmpdir(), `bench-${b.name}-${mode}-`));
      const repo = freshRepo(b, root);
      const t0 = Date.now();
      log(`[bench] ${b.name} / ${mode}`);
      if (mode === 'baseline') {
        const r = await o.baseline({ cwd: repo, prompt: b.prompt, timeoutMs: 30 * 60_000 });
        const j = await judge(b, repo);
        results.push({ benchmark: b.name, mode, accepted: j.accepted, passed: j.passed, failed: j.failed, costUsd: r.costUsd, minutes: (Date.now() - t0) / 60000, error: r.error, acceptanceLog: j.log });
        continue;
      }
      const policyPath = join(root, 'devpilot.yaml');
      writeFileSync(policyPath, BENCH_POLICY + (b.policy ?? ''));
      const store = new MemoryStore(join(root, 'state.json'));
      await store.init();
      const orch = new Orchestrator({ store, runner: o.runner, dataDir: join(root, 'data'), policiesDir: o.policiesDir, workerId: 'bench', log });
      await orch.registerProject({ id: b.name, repoPath: repo, policyPath });
      let t = await orch.run((await orch.createTask({ projectId: b.name, prompt: b.prompt })).id, { waitOnPause: true });
      for (let i = 0; i < 3 && t.state === 'AWAITING_APPROVAL' && o.autoApprove; i++) {
        log(`[bench] auto-approving ${t.approval?.kind}: ${t.approval?.questions.join(' / ')}`);
        await orch.approve(t.id, o.autoApprove);
        t = await orch.run(t.id, { waitOnPause: true });
      }
      const checkout = t.worktreePath ?? repo;
      const j = await judge(b, checkout);
      results.push({ benchmark: b.name, mode, accepted: j.accepted, passed: j.passed, failed: j.failed, costUsd: t.costUsd, minutes: (Date.now() - t0) / 60000, taskState: t.state, repairs: t.repairAttempts, humanInput: t.humanInput.length, error: t.stopReason, acceptanceLog: j.log });
    }
  }
  mkdirSync(o.outDir, { recursive: true });
  const reportPath = join(o.outDir, `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  writeFileSync(reportPath, renderBench(results));
  writeFileSync(reportPath.replace(/\.md$/, '.json'), JSON.stringify(results, null, 2));
  return { results, reportPath };
}

export function renderBench(results: BenchResult[]): string {
  const L = ['# DevPilot vs plain Claude Code', '', 'Same prompt, same repo, judged by the same hidden acceptance tests.', ''];
  L.push('| Benchmark | Mode | Accepted | Hidden tests | DevPilot state | Repairs | Cost | Minutes |', '|---|---|---|---|---|---|---|---|');
  for (const r of results) L.push(`| ${r.benchmark} | ${r.mode} | ${r.accepted ? '✅' : '❌'} | ${r.passed}/${r.passed + r.failed} | ${r.taskState ?? '-'} | ${r.repairs ?? '-'} | $${r.costUsd.toFixed(2)} | ${r.minutes.toFixed(1)} |`);
  L.push('');
  for (const mode of ['devpilot', 'baseline'] as const) {
    const rs = results.filter((r) => r.mode === mode);
    if (!rs.length) continue;
    const acc = rs.filter((r) => r.accepted);
    const cost = rs.reduce((s, r) => s + r.costUsd, 0);
    L.push(`- **${mode}**: accepted ${acc.length}/${rs.length}, cost per accepted task ${acc.length ? `$${(cost / acc.length).toFixed(2)}` : '—'}, total $${cost.toFixed(2)}`);
  }
  return L.join('\n');
}
