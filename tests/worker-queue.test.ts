import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgStore } from '@devpilot/database';
import { Orchestrator, enqueueStep, redisConnection, startWorker } from '@devpilot/orchestrator';
import { ScriptedAgentRunner } from '@devpilot/agent-runtime';
import { baseHandlers, makeRepo } from './helpers';

const db = process.env.DATABASE_URL;
const redis = process.env.REDIS_URL;
const waitFor = async (fn: () => Promise<boolean>, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timeout');
};

test('worker crash mid-step: lease expires, a second worker recovers the task to DONE', { skip: !(db && redis) && 'DATABASE_URL / REDIS_URL not set', timeout: 120_000 }, async () => {
  const store = new PgStore(db!);
  await store.init();
  const connA = redisConnection(redis);
  const connB = redisConnection(redis);
  const env = makeRepo();
  try {
    // Own queue + recovery scoped to our project: never touches a live DevPilot on the same Redis/DB.
    const queueName = `devpilot-test-${Date.now()}`;
    // Worker A hangs forever inside the developer agent, then "crashes".
    let devStarted = false;
    const runnerA = new ScriptedAgentRunner(baseHandlers({ developer: () => ((devStarted = true), new Promise(() => {})) }));
    const orchA = new Orchestrator({ store, runner: runnerA, dataDir: env.dataDir, workerId: 'worker-A', leaseMs: 1500 });
    const projectId = `q-${Date.now()}`;
    await orchA.registerProject({ id: projectId, repoPath: env.repo, policyPath: env.policyPath });
    const task = await orchA.createTask({ projectId, prompt: 'Add subtract' });
    const A = await startWorker({ orchestrator: orchA, store, connection: connA, recover: false, busyRetryMs: 500, queueName });
    await enqueueStep(A.queue, task.id, task.version);
    await waitFor(async () => devStarted);
    assert.equal((await store.getTask(task.id))!.state, 'IMPLEMENTATION');

    orchA.stopHeartbeats(); // process "dies": no more lease renewals
    await A.worker.close(true);
    await A.queue.close();

    // Worker B starts and recovers active tasks from PostgreSQL.
    const runnerB = new ScriptedAgentRunner(baseHandlers());
    const orchB = new Orchestrator({ store, runner: runnerB, dataDir: env.dataDir, workerId: 'worker-B', leaseMs: 1500 });
    const B = await startWorker({ orchestrator: orchB, store, connection: connB, recover: true, busyRetryMs: 500, queueName, projectIds: [projectId] });
    await waitFor(async () => ['DONE', 'BLOCKED', 'FAILED'].includes((await store.getTask(task.id))!.state));
    const t = (await store.getTask(task.id))!;
    assert.equal(t.state, 'DONE', t.stopReason ?? '');
    assert.deepEqual(runnerB.calls.map((c) => c.role), ['developer', 'qa', 'reviewer'], 'B did not redo research/spec');
    const busy = (await store.listEvents(task.id)).filter((e) => e.type === 'step_started' && e.data.worker === 'worker-B');
    assert.ok(busy.length >= 4);
    await B.queue.obliterate({ force: true }).catch(() => {});
    await B.close();
  } finally {
    connA.disconnect();
    connB.disconnect();
    await store.close();
  }
});
