import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Task } from '@devpilot/shared';
import { bootstrap } from '@devpilot/orchestrator';
import { attachNotifier, notifierConfigFromEnv } from '@devpilot/notifier';
import { computeMetrics } from '@devpilot/metrics';
import { affectedTests, buildContext, dataNeighbours, dependents, featureMemory, formatContext, summarize, symbolConsumers } from '@devpilot/project-intelligence';

const HELP = `devpilot — autonomous development orchestrator (CLI mode, no Redis needed)

  project add <id> <repoPath> [--policy <file>] [--branch <name>]
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
  bench [names...] [--modes devpilot,baseline] [--auto-approve <answer>]
                                       control tasks: DevPilot vs plain Claude Code, judged by hidden tests

Env: DEVPILOT_DATA_DIR (default ./.devpilot), DATABASE_URL (use PostgreSQL)`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { policy: { type: 'string' }, branch: { type: 'string' }, note: { type: 'string' }, modes: { type: 'string' }, 'auto-approve': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});
const [cmd, ...rest] = positionals;
if (!cmd || values.help) {
  console.log(HELP);
  process.exit(0);
}

const { store, orchestrator } = await bootstrap({ workerId: `cli-${process.pid}`, log: (l) => console.log(`\x1b[2m${l}\x1b[0m`) });
const notify = notifierConfigFromEnv();
if (notify) attachNotifier(orchestrator, notify, (l) => console.error(l));

const color = (s: string) =>
  ({ passed: '\x1b[32m', failed: '\x1b[31m', not_verified: '\x1b[33m', skipped: '\x1b[2m', pending: '\x1b[36m' })[s] ?? '';

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
  if (t.pausedUntil && Date.parse(t.pausedUntil) > Date.now()) console.log(`\nPAUSED: subscription usage limit until ${t.pausedUntil}`);
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
        console.log(`project ${p.id} -> ${p.repoPath} (policy: ${p.policyPath ?? 'defaults'}, base: ${p.defaultBranch})`);
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
        log: (l) => console.log(`\x1b[2m${l}\x1b[0m`),
      });
      for (const r of results)
        console.log(`${r.benchmark.padEnd(16)} ${r.mode.padEnd(9)} ${r.accepted ? 'ACCEPTED' : 'REJECTED'}  hidden ${r.passed}/${r.passed + r.failed}  $${r.costUsd.toFixed(2)}  ${r.minutes.toFixed(1)}min${r.taskState ? '  ' + r.taskState : ''}`);
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
  await store.close();
}
