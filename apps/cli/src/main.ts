import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Task } from '@devpilot/shared';
import { bootstrap } from '@devpilot/orchestrator';

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

Env: DEVPILOT_DATA_DIR (default ./.devpilot), DATABASE_URL (use PostgreSQL)`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { policy: { type: 'string' }, branch: { type: 'string' }, note: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});
const [cmd, ...rest] = positionals;
if (!cmd || values.help) {
  console.log(HELP);
  process.exit(0);
}

const { store, orchestrator } = await bootstrap({ workerId: `cli-${process.pid}`, log: (l) => console.log(`\x1b[2m${l}\x1b[0m`) });

const color = (s: string) =>
  ({ passed: '\x1b[32m', failed: '\x1b[31m', not_verified: '\x1b[33m', skipped: '\x1b[2m', pending: '\x1b[36m' })[s] ?? '';

function show(t: Task) {
  console.log(`\n${t.id}  ${t.state}  ${t.title}`);
  console.log(`branch ${t.branch ?? '-'}  head ${t.headCommit?.slice(0, 8) ?? '-'}  repairs ${t.repairAttempts}  cost $${t.costUsd.toFixed(2)}`);
  if (t.requirements.length) {
    console.log('\nRequirements:');
    for (const r of t.requirements) console.log(`  ${r.id} [${r.status}] ${r.description}${r.tests.length ? `  (${r.tests.join(', ')})` : ''}`);
  }
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
      show(await orchestrator.run(t.id, { waitOnPause: true }));
      break;
    }
    case 'continue':
      show(await orchestrator.run(rest[0]!, { waitOnPause: true }));
      break;
    case 'status': {
      if (rest[0]) {
        const t = await store.getTask(rest[0]);
        if (!t) throw new Error('not found');
        show(t);
      } else for (const t of await store.listTasks()) console.log(`${t.id}\t${t.state.padEnd(18)}\t$${t.costUsd.toFixed(2)}\t${t.title}`);
      break;
    }
    case 'events':
      for (const e of await store.listEvents(rest[0]!)) console.log(`${e.ts}  ${e.type.padEnd(18)} ${JSON.stringify(e.data)}`);
      break;
    case 'approve': {
      const [id, ...words] = rest;
      await orchestrator.approve(id!, words.join(' ') || 'approved');
      show(await orchestrator.run(id!, { waitOnPause: true }));
      break;
    }
    case 'resume':
      await orchestrator.resume(rest[0]!, { note: values.note });
      show(await orchestrator.run(rest[0]!, { waitOnPause: true }));
      break;
    case 'cancel':
      show(await orchestrator.cancel(rest[0]!));
      break;
    case 'report': {
      const t = await store.getTask(rest[0]!);
      if (!t?.reportPath || !existsSync(t.reportPath)) throw new Error('no report yet');
      console.log(readFileSync(t.reportPath, 'utf8'));
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
