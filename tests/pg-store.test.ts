import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgStore } from '@devpilot/database';
import { Orchestrator } from '@devpilot/orchestrator';
import { ScriptedAgentRunner } from '@devpilot/agent-runtime';
import { baseHandlers, makeRepo } from './helpers';

const url = process.env.DATABASE_URL;

test('PostgreSQL store: full task lifecycle, optimistic locking, leases, immutable log', { skip: !url && 'DATABASE_URL not set' }, async () => {
  const store = new PgStore(url!);
  await store.init();
  try {
    const env = makeRepo();
    const orch = new Orchestrator({ store, runner: new ScriptedAgentRunner(baseHandlers()), dataDir: env.dataDir, workerId: 'pg-test' });
    const projectId = `sample-${Date.now()}`;
    await orch.registerProject({ id: projectId, repoPath: env.repo, policyPath: env.policyPath });
    const t0 = await orch.createTask({ projectId, prompt: 'Add subtract' });
    const t = await orch.run(t0.id);
    assert.equal(t.state, 'DONE', t.stopReason ?? '');
    assert.ok((await store.listEvents(t.id)).length > 10);
    assert.equal((await store.listAgentRuns(t.id)).length, 6);

    // knowledge recorded on DONE lives in PostgreSQL too
    const k = await store.getKnowledge<{ features: { taskId: string }[] }>(projectId);
    assert.equal(k?.features[0]?.taskId, t.id);
    // stale write is rejected
    await assert.rejects(store.saveTask(t, t.version - 1), /version conflict/);
    // lease is exclusive
    assert.equal(await store.acquireLease(t.id, 'a', 60_000), true);
    assert.equal(await store.acquireLease(t.id, 'b', 60_000), false);
    await store.releaseLease(t.id, 'a');
    // event log is append-only
    await assert.rejects(
      (store as any).pool.query('DELETE FROM task_events WHERE task_id=$1', [t.id]),
      /append-only/,
    );
  } finally {
    await store.close();
  }
});
