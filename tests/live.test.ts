import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeCliRunner, DiscoveryOutput, activityOf } from '@devpilot/agent-runtime';
import { MemoryStore } from '@devpilot/database';
import { loadPolicy } from '@devpilot/policy-engine';
import { AGENTS_DIR } from '@devpilot/orchestrator';
import { buildApi } from '../apps/api/src/app';
import { POLICY, makeRepo, setup } from './helpers';
import { handlers as dagHandlers } from './fixtures/subtask-plan';

test('activity: tool calls become short live lines (file, command or pattern)', async () => {
  assert.deepEqual(activityOf('Edit', { file_path: 'src/a.js', old_string: 'x' }), { tool: 'Edit', target: 'src/a.js' });
  assert.deepEqual(activityOf('Bash', { command: 'npm   test\n --grep x' }), { tool: 'Bash', target: 'npm test --grep x' });
  assert.equal(activityOf('Grep', { pattern: 'x'.repeat(500) }).target!.length, 140);
  const FAKE = join(import.meta.dirname, 'fixtures/fake-claude.mjs');
  const env = makeRepo();
  const runner = new ClaudeCliRunner({ policy: loadPolicy(env.policyPath), policyPath: env.policyPath, agentsDir: AGENTS_DIR, claudeBin: FAKE });
  const seen: unknown[] = [];
  const r = await runner.run({ role: 'researcher', taskId: 'T', prompt: 'p', cwd: env.repo, schema: DiscoveryOutput, model: 'm', effort: 'high', maxTurns: 5, budgetUsd: 1, timeoutMs: 60_000, onActivity: (a) => seen.push(a), pidFile: join(env.root, 'agent.pid') });
  assert.equal(r.ok, true, r.error ?? '');
  assert.deepEqual(seen, [{ tool: 'Bash', target: 'npm test -- --grep booking' }]);
  assert.equal(existsSync(join(env.root, 'agent.pid')), false, 'pid file removed after the agent exits');
});

test('GET /live: running task, its subtask graph, and the feed', async () => {
  const e = await setup(dagHandlers(), POLICY.replace('execution: { agent_sandbox: false, mode: pipeline }', 'execution: { agent_sandbox: false, mode: pipeline, max_parallel_agents: 2 }'));
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Math v2' })).id);
  assert.equal(t.state, 'DONE');
  const app = buildApi({ orchestrator: e.orch, schedule: async () => {}, mode: 'embedded' });
  const live = (await app.inject({ method: 'GET', url: '/live' })).json();
  assert.equal(live.tasks.length, 1, 'a task finished in the last 2h stays on the live page');
  const [x] = live.tasks;
  assert.equal(x.task.id, t.id);
  assert.equal(x.children.length, 3);
  assert.deepEqual(x.running, []);
  assert.ok(x.feed.some((ev: any) => ev.type === 'subtask_integrated'));
  assert.ok(x.feed.some((ev: any) => ev.type === 'state_changed' && ev.data.to === 'DONE'));
  const page = await app.inject({ method: 'GET', url: '/dashboard/app.js' });
  assert.match(page.body, /async function viewLive/);
  await app.close();
});

test('state file: a second writing process is refused; a reader never overwrites newer state', async () => {
  const env = makeRepo();
  const file = join(env.dataDir, 'state.json');
  const a = new MemoryStore(file);
  await a.init();
  await a.upsertProject({ id: 'p', repoPath: env.repo, defaultBranch: 'main', createdAt: new Date().toISOString() });
  // a reader (e.g. `status`) opens the file, the writer moves on, the reader closes: nothing lost
  const reader = new MemoryStore(file);
  await reader.init();
  await a.upsertProject({ id: 'q', repoPath: env.repo, defaultBranch: 'main', createdAt: new Date().toISOString() });
  await reader.close();
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).projects.q, 'newer state survived the reader');
  // another live process holding the lock -> writes are refused instead of corrupting the file
  writeFileSync(`${file}.lock`, String(process.ppid));
  const b = new MemoryStore(file);
  await b.init();
  await assert.rejects(b.upsertProject({ id: 'z', repoPath: env.repo, defaultBranch: 'main', createdAt: '' }), /being written by another DevPilot process/);
  // a stale lock from a dead process is taken over
  writeFileSync(`${file}.lock`, '999999');
  await b.upsertProject({ id: 'z', repoPath: env.repo, defaultBranch: 'main', createdAt: '' });
  await b.close();
  await a.close();
});
