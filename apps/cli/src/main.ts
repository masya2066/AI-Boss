import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Task } from '@devpilot/shared';
const isTerminalState = (s: string) => ['DONE', 'FAILED', 'CANCELLED'].includes(s);
import { bootstrap } from '@devpilot/orchestrator';
import { planGates } from '@devpilot/policy-engine';
import { attachNotifier, notifierConfigFromEnv } from '@devpilot/notifier';
import { computeMetrics } from '@devpilot/metrics';
import { affectedTests, buildContext, dataNeighbours, dependents, featureMemory, formatContext, summarize, symbolConsumers } from '@devpilot/project-intelligence';

const HELP = `devpilot — autonomous development orchestrator (CLI mode, no Redis needed)

  project add <id> <repoPath> [--policy <file>] [--branch <name>]
                                       register any git repo; build/test commands are auto-detected
  project show <id>                    effective gates and commands (detected <- devpilot.yaml)
  project check <id> [--adopt]         run the gates on the untouched base branch; --adopt switches
                                       off gates that already fail there (with the evidence as reason)
  project list
  run <projectId> <prompt...>          create a task and drive it until done / waiting
  continue <taskId>                    keep driving an existing task (crash recovery)
  status [taskId]                      list tasks or show one in detail
  events <taskId>                      full event log
  approve <taskId> <answer...>         answer an approval request and continue
  resume <taskId> [--note <text>]      unblock a BLOCKED task and continue
  cancel <taskId>
  report <taskId>
  index <projectId>                    build/refresh the Project Intelligence index, print the architecture map
  search <projectId> <terms...>        concept search + deterministic context expansion
  impact <projectId> <file> [symbol]   consumers, tests and data neighbours of a file / exported symbol
  knowledge <projectId>                delivered features and business rules remembered for the project
  metrics [projectId]                  quality & cost metrics (first-pass, autonomy, coverage, cost/task …)
  bench [names...] [--modes devpilot,baseline] [--trials N] [--concurrency N] [--auto-approve <answer>]
                                       control tasks: DevPilot vs plain Claude Code, judged by hidden tests

Live view: run/continue/approve/resume/bench serve the dashboard while they work
  (http://127.0.0.1:4317/dashboard/#/live, next free port if busy; DEVPILOT_DASHBOARD=0 disables).
  For a dashboard that stays up between commands: npm run api.

Env: DEVPILOT_DATA_DIR (default ./.devpilot), DATABASE_URL (use PostgreSQL)`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { trials: { type: 'string' }, concurrency: { type: 'string' }, adopt: { type: 'boolean' }, policy: { type: 'string' }, branch: { type: 'string' }, note: { type: 'string' }, modes: { type: 'string' }, 'auto-approve': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});
const [cmd, ...rest] = positionals;
if (!cmd || values.help) {
  console.log(HELP);
  process.exit(0);
}

const LIVE_CMDS = new Set(['run', 'continue', 'approve', 'resume', 'bench']);
const { store, orchestrator } = await bootstrap({ workerId: `cli-${process.pid}`, log: (l) => console.log(`\x1b[2m${l}\x1b[0m`) });
// Live view: every command that drives tasks also serves the dashboard from this very process
// (same store, events arrive instantly). DEVPILOT_DASHBOARD=0 turns it off.
let liveServer: { close: () => Promise<unknown> } | undefined;
if (LIVE_CMDS.has(cmd) && process.env.DEVPILOT_DASHBOARD !== '0') liveServer = await startLive();

async function startLive() {
  const { buildApi } = await import('../../api/src/app');
  const { LocalScheduler } = await import('@devpilot/orchestrator');
  const local = new LocalScheduler(orchestrator, store, () => {});
  const host = process.env.DEVPILOT_DASHBOARD_HOST ?? '127.0.0.1';
  const first = Number(process.env.DEVPILOT_DASHBOARD_PORT ?? 4317);
  for (let port = first; port < first + 10; port++) {
    const app = buildApi({ orchestrator, schedule: (id) => local.schedule(id), token: process.env.DEVPILOT_API_TOKEN, mode: 'embedded' });
    try {
      await app.listen({ port, host });
      console.log(`\x1b[36mLive: http://${host}:${port}/dashboard/#/live\x1b[0m`);
      return app;
    } catch (e: any) {
      await app.close();
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  console.log('Live view: no free port (set DEVPILOT_DASHBOARD_PORT)');
  return undefined;
}

const notify = notifierConfigFromEnv();
if (notify) attachNotifier(orchestrator, notify, (l) => console.error(l));

const color = (s: string) =>
  ({ passed: '\x1b[32m', failed: '\x1b[31m', not_verified: '\x1b[33m', skipped: '\x1b[2m', pending: '\x1b[36m' })[s] ?? '';

function showPolicy(p: { id: string; repoPath: string; policyPath?: string }) {
  const pol = orchestrator.policyFor(p as never).project;
  console.log(`\nStack: ${pol.detected.stack.join(', ') || 'not detected'}`);
  const cmds = pol.commands as Record<string, string | undefined>;
  if (cmds.setup) console.log(`  setup              ${cmds.setup}`);
  for (const g of planGates(pol, [])) {
    const mode = typeof pol.quality[g.name] === 'string' ? pol.quality[g.name] : (pol.quality[g.name] as { mode: string }).mode;
    const why = mode === 'off' ? g.reason : (pol.detected.sources[g.name] ?? (g.command ? 'devpilot.yaml' : 'built-in'));
    const what = g.command ?? (['diff_present', 'test_integrity', 'secrets_scan', 'requirements_coverage', 'independent_review'].includes(g.name) ? '(built-in)' : '\x1b[31mNO COMMAND -> NOT_VERIFIED\x1b[0m');
    console.log(`  ${g.name.padEnd(18)} ${String(mode).padEnd(11)} ${mode === 'off' ? '' : what}  \x1b[2m${why}\x1b[0m`);
  }
}

async function show(t: Task) {
  console.log(`\n${t.id}  ${t.state}  ${t.title}`);
  console.log(`branch ${t.branch ?? '-'}  head ${t.headCommit?.slice(0, 8) ?? '-'}  repairs ${t.repairAttempts}  cost $${t.costUsd.toFixed(2)}`);
  if (t.requirements.length) {
    console.log('\nRequirements:');
    for (const r of t.requirements) console.log(`  ${r.id} [${r.status}] ${r.description}${r.tests.length ? `  (${r.tests.join(', ')})` : ''}`);
  }
  if (t.subtasks?.length) {
    console.log('\nSubtasks:');
    for (const s of t.subtasks) {
      const c = s.taskId ? await store.getTask(s.taskId) : undefined;
      console.log(`  ${s.key} ${(c?.state ?? 'not started').padEnd(18)} ${s.integratedCommit ? 'integrated ' + s.integratedCommit.slice(0, 8) : ''}${s.conflicts ? ' (conflicts resolved: ' + s.conflicts.join(', ') + ')' : ''}  ${s.title}${s.dependsOn.length ? '  after ' + s.dependsOn.join(', ') : ''}${c ? '  ' + c.id : ''}`);
    }
  }
  if (t.parentId) console.log(`\nSubtask ${t.subtaskKey} of ${t.parentId}`);
  const gates = Object.values(t.gates);
  if (gates.length) {
    console.log('\nGates:');
    for (const g of gates) console.log(`  ${color(g.status)}${g.status.padEnd(12)}\x1b[0m ${g.name.padEnd(22)} ${g.required ? '' : '(optional) '}${g.reason ?? ''}`);
  }
  const open = t.defects.filter((d) => !d.resolved);
  if (open.length) {
    console.log('\nOpen defects:');
    for (const d of open) console.log(`  [${d.severity}] ${d.summary}`);
  }
  if (t.approval && t.state === 'AWAITING_APPROVAL') {
    console.log(`\nAWAITING APPROVAL (${t.approval.kind}): ${t.approval.reason}`);
    for (const q of t.approval.questions) console.log(`  - ${q}`);
    console.log(`\n  devpilot approve ${t.id} "<your answer>"`);
  }
  if (t.state === 'BLOCKED') console.log(`\nBLOCKED: ${t.stopReason}\n  devpilot resume ${t.id} --note "<what you changed>"`);
  if (t.pausedUntil && Date.parse(t.pausedUntil) > Date.now() && t.waitReason !== 'subtasks')
    console.log(`\nPAUSED (${{ usage_limit: 'subscription usage limit', ci: 'waiting for CI', budget: 'daily budget reached' }[t.waitReason ?? 'usage_limit'] ?? t.waitReason}) until ${t.pausedUntil}`);
  if (!isTerminalState(t.state) && t.state !== 'AWAITING_APPROVAL' && t.state !== 'BLOCKED') console.log(`\nStill running: devpilot continue ${t.id}`);
  if (t.reportPath) console.log(`\nReport: ${t.reportPath}`);
  if (t.prUrl) console.log(`PR: ${t.prUrl}`);
}

try {
  switch (cmd) {
    case 'project': {
      if (rest[0] === 'add') {
        const [, id, repo] = rest;
        if (!id || !repo) throw new Error('usage: project add <id> <repoPath>');
        const p = await orchestrator.registerProject({ id, repoPath: repo, policyPath: values.policy, defaultBranch: values.branch });
        console.log(`project ${p.id} -> ${p.repoPath} (policy: ${p.policyPath ?? 'auto-detected'}, base: ${p.defaultBranch})`);
        showPolicy(p);
        console.log(`\nNext: devpilot project check ${p.id} --adopt   (verifies the gates on ${p.defaultBranch} before the first task)`);
      } else if (rest[0] === 'show') {
        const p = await store.getProject(rest[1] ?? '');
        if (!p) throw new Error(`unknown project ${rest[1]}`);
        showPolicy(p);
      } else if (rest[0] === 'check') {
        const r = await orchestrator.checkProject(rest[1] ?? '', { adopt: Boolean(values.adopt) });
        console.log(`\nBaseline ${r.commit.slice(0, 8)} (${r.stack.join(', ') || 'unknown stack'}):`);
        for (const x of r.results) {
          console.log(`  ${color(x.status === 'passed' ? 'passed' : 'failed')}${x.status.padEnd(8)}\x1b[0m ${x.name.padEnd(18)} ${x.command}  (${x.seconds}s)`);
          if (x.status !== 'passed') console.log(x.tail.replace(/^/gm, '      '));
        }
        if (r.results.find((x) => x.name === 'setup' && x.status !== 'passed')) console.log('\nSetup failed: fix commands.setup in devpilot.yaml (or the environment) first.');
        else if (r.adopted.length) console.log(`\nSwitched off (already failing on the base branch): ${r.adopted.join(', ')}`);
        else if (r.results.some((x) => x.status !== 'passed')) console.log(`\nRe-run with --adopt to switch the failing gates off, or fix them / configure devpilot.yaml.`);
        else console.log('\nAll gates pass on the base branch: ready for tasks.');
      } else for (const p of await store.listProjects()) console.log(`${p.id}\t${p.repoPath}\t${p.defaultBranch}`);
      break;
    }
    case 'run': {
      const [projectId, ...words] = rest;
      if (!projectId || !words.length) throw new Error('usage: run <projectId> <prompt>');
      const t = await orchestrator.createTask({ projectId, prompt: words.join(' ') });
      console.log(`created ${t.id}`);
      await show(await orchestrator.run(t.id, { waitOnPause: true }));
      break;
    }
    case 'continue':
      await show(await orchestrator.run(rest[0]!, { waitOnPause: true }));
      break;
    case 'status': {
      if (rest[0]) {
        const t = await store.getTask(rest[0]);
        if (!t) throw new Error('not found');
        await show(t);
      } else for (const t of await store.listTasks()) console.log(`${t.id}\t${t.state.padEnd(18)}\t$${t.costUsd.toFixed(2)}\t${t.title}`);
      break;
    }
    case 'events':
      for (const e of await store.listEvents(rest[0]!)) console.log(`${e.ts}  ${e.type.padEnd(18)} ${JSON.stringify(e.data)}`);
      break;
    case 'approve': {
      const [id, ...words] = rest;
      await orchestrator.approve(id!, words.join(' ') || 'approved');
      await show(await orchestrator.run(id!, { waitOnPause: true }));
      break;
    }
    case 'resume':
      await orchestrator.resume(rest[0]!, { note: values.note });
      await show(await orchestrator.run(rest[0]!, { waitOnPause: true }));
      break;
    case 'cancel':
      await show(await orchestrator.cancel(rest[0]!));
      break;
    case 'report': {
      const t = await store.getTask(rest[0]!);
      if (!t?.reportPath || !existsSync(t.reportPath)) throw new Error('no report yet');
      console.log(readFileSync(t.reportPath, 'utf8'));
      break;
    }
    case 'index': {
      const idx = await orchestrator.projectIndex(rest[0]!);
      console.log(summarize(idx, { maxFiles: 0 }));
      console.log(`\nindexed ${idx.stats.files} files in ${idx.stats.ms}ms (parsed ${idx.stats.parsed}, reused ${idx.stats.reused} from cache)`);
      break;
    }
    case 'search': {
      const [projectId, ...terms] = rest;
      const idx = await orchestrator.projectIndex(projectId!);
      console.log(formatContext(buildContext(idx, { terms: [terms.join(' ')] })));
      break;
    }
    case 'impact': {
      const [projectId, file, symbol] = rest;
      const idx = await orchestrator.projectIndex(projectId!);
      if (!idx.files.includes(file!)) throw new Error(`${file} is not in the index`);
      if (symbol) {
        console.log(`Consumers of ${file}#${symbol}:`);
        const cons = symbolConsumers(idx, file!, symbol);
        if (!cons.length) console.log('  (none — no file imports this symbol)');
        for (const c of cons) console.log(`  ${c.file}${c.via !== file ? `  (via ${c.via})` : ''}`);
      }
      console.log(`Dependents (reverse imports): ${dependents(idx, [file!]).join(', ') || '-'}`);
      console.log(`Tests: ${affectedTests(idx, [file!]).join(', ') || '-'}`);
      for (const n of dataNeighbours(idx, [file!])) console.log(`Same table "${n.table}": ${n.files.join(', ')}`);
      const exp = idx.facts[file!]?.declarations.filter((d) => d.exported).map((d) => d.name) ?? [];
      if (exp.length) console.log(`Exported symbols: ${exp.join(', ')}`);
      break;
    }
    case 'bench': {
      const { BENCH_POLICY, claudeBaseline, loadBenchmarks, runBenchmarks } = await import('@devpilot/benchmark');
      const { ClaudeCliRunner } = await import('@devpilot/agent-runtime');
      const { loadPolicy } = await import('@devpilot/policy-engine');
      const { AGENTS_DIR, ROOT } = await import('@devpilot/orchestrator');
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const polPath = join(mkdtempSync(join(tmpdir(), 'bench-pol-')), 'devpilot.yaml');
      writeFileSync(polPath, BENCH_POLICY);
      const runner = new ClaudeCliRunner({ policy: loadPolicy(polPath), policyPath: polPath, agentsDir: AGENTS_DIR });
      const modes = (values.modes ?? 'devpilot,baseline').split(',') as ('devpilot' | 'baseline')[];
      const { results, reportPath } = await runBenchmarks({
        benchmarks: loadBenchmarks(join(ROOT, 'benchmarks'), rest),
        modes,
        runner,
        baseline: claudeBaseline(),
        outDir: join(process.env.DEVPILOT_DATA_DIR ?? '.devpilot', 'bench'),
        autoApprove: values['auto-approve'],
        trials: Number(values.trials ?? 1),
        concurrency: Number(values.concurrency ?? 1),
        orchestrator, // DevPilot runs appear in this process's live dashboard
        log: (l) => console.log(`\x1b[2m${l}\x1b[0m`),
      });
      for (const r of results)
        console.log(`${r.benchmark.padEnd(22)} ${r.mode.padEnd(9)} #${r.trial ?? 1} ${r.accepted ? 'ACCEPTED' : 'REJECTED'}  hidden ${r.passed}/${r.passed + r.failed}  $${r.costUsd.toFixed(2)}  ${r.minutes.toFixed(1)}min${r.taskState ? '  ' + r.taskState : ''}${r.error ? '  ' + r.error.slice(0, 120) : ''}`);
      console.log(`\nReport: ${reportPath}`);
      break;
    }
    case 'metrics': {
      console.log(JSON.stringify(await computeMetrics(store, { projectId: rest[0] }), null, 2));
      break;
    }
    case 'knowledge': {
      const k = await orchestrator.knowledge(rest[0]!);
      console.log(k?.features.length ? featureMemory(k.features) : 'nothing remembered yet (features are recorded when tasks reach DONE)');
      break;
    }
    default:
      console.log(HELP);
  }
} catch (e: any) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
} finally {
  await liveServer?.close();
  await store.close();
}
