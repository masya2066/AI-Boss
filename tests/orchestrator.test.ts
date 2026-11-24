import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '@devpilot/database';
import { Orchestrator } from '@devpilot/orchestrator';
import { ScriptedAgentRunner } from '@devpilot/agent-runtime';
import { POLICY, baseHandlers, setup, writeSubtract } from './helpers';

test('happy path: research -> spec -> plan -> code -> gates -> review -> DONE', async () => {
  const { orch, store, runner } = await setup();
  const t0 = await orch.createTask({ projectId: 'sample', prompt: 'Add a subtract function to the math module' });
  const t = await orch.run(t0.id);
  assert.equal(t.state, 'DONE', t.stopReason ?? "");
  assert.deepEqual(runner.calls.map((c) => c.role), ['researcher', 'architect', 'architect', 'developer', 'qa', 'reviewer']);
  for (const g of Object.values(t.gates).filter((g) => g.required)) {
    assert.equal(g.status, 'passed', `${g.name}: ${g.reason}`);
    assert.equal(g.commit, t.headCommit, `${g.name} bound to HEAD`);
  }
  assert.equal(t.requirements[0]!.status, 'covered');
  assert.deepEqual(t.impact!.dependentFiles, ['src/calc.js', 'tests/add.test.js'], 'import graph found consumers');
  assert.ok(t.impact!.affectedTests.includes('tests/add.test.js'));
  assert.ok(t.reportPath && existsSync(t.reportPath));
  assert.match(readFileSync(t.reportPath!, 'utf8'), /independent_review/);
  const states = (await store.listEvents(t.id)).filter((e) => e.type === 'state_changed').map((e) => e.data.to);
  assert.deepEqual(states, ['DISCOVERY', 'SPECIFICATION', 'IMPACT_ANALYSIS', 'IMPLEMENTATION', 'VALIDATION', 'REVIEW', 'DELIVERY', 'DONE']);
  assert.ok((await store.listEvents(t.id)).some((e) => e.type === 'delivered_locally'), 'no remote -> local delivery');
});

test('failing tests trigger repair, then full re-validation and review', async () => {
  const { orch, runner } = await setup(
    baseHandlers({
      developer: (req) => {
        writeSubtract(req.cwd, 'a + b'); // bug
        return { summary: 'done, all tests pass', filesChanged: ['src/math.js'], notes: [] }; // false claim
      },
    }),
  );
  const t = await orch.run((await orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t.state, 'DONE', t.stopReason ?? "");
  assert.equal(t.repairAttempts, 1);
  assert.ok(t.defects.some((d) => d.gate === 'unit_tests' && d.resolved));
  const roles = runner.calls.map((c) => c.role);
  assert.deepEqual(roles.slice(-2), ['fixer', 'reviewer'], 'review ran after the fix, on the new commit');
});

test('agent that cannot fix the same failure is stopped (BLOCKED), not looped forever', async () => {
  const { orch, runner } = await setup(
    baseHandlers({
      developer: (req) => (writeSubtract(req.cwd, 'a + b'), { summary: 'x', filesChanged: [], notes: [] }),
      fixer: () => ({ summary: 'I fixed it', defectsAddressed: [] }), // changes nothing
    }),
  );
  const t = await orch.run((await orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t.state, 'BLOCKED');
  assert.match(t.stopReason!, /same failure repeated 3 times/);
  assert.equal(runner.calls.filter((c) => c.role === 'fixer').length, 2);
});

test('blocking review finding sends the task back to repair', async () => {
  let reviews = 0;
  const { orch } = await setup(
    baseHandlers({
      reviewer: () =>
        ++reviews === 1
          ? { findings: [{ severity: 'blocker', title: 'subtract lacks input validation', description: 'NaN for strings', file: 'src/math.js' }], unmetRequirements: [] }
          : { findings: [{ severity: 'minor', title: 'naming', description: 'ok' }], unmetRequirements: [] },
      fixer: (req) => (writeSubtract(req.cwd, "(typeof a !== 'number' || typeof b !== 'number') ? NaN : a - b"), { summary: 'validate', defectsAddressed: [] }),
    }),
  );
  const t = await orch.run((await orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t.state, 'DONE', t.stopReason ?? "");
  assert.equal(reviews, 2);
  assert.equal(t.gates.independent_review!.status, 'passed');
});

test('required gate without a command is NOT_VERIFIED and blocks delivery', async () => {
  // Nothing to detect for integration tests, and the project YAML makes them required.
  const { orch } = await setup(baseHandlers(), POLICY.replace('integration_tests: off', 'integration_tests: required'));
  const t = await orch.run((await orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t.state, 'BLOCKED');
  assert.equal(t.gates.integration_tests!.status, 'not_verified');
  assert.match(t.stopReason!, /cannot verify required gates: integration_tests/);
});

test('QA skipping tests is caught by the integrity gate', async () => {
  const { orch } = await setup(
    baseHandlers({
      developer: (req) => (writeSubtract(req.cwd, 'a + b'), { summary: 'x', filesChanged: [], notes: [] }),
      qa: (req) => {
        writeFileSync(join(req.cwd, 'tests/subtract.test.js'), "import test from 'node:test';\ntest.skip('subtract', () => {});\n");
        return { testFiles: ['tests/subtract.test.js'], requirementTests: [{ requirementId: 'REQ-01', testFiles: ['tests/subtract.test.js'] }], notes: [] };
      },
      fixer: () => ({ summary: 'nothing', defectsAddressed: [] }),
    }),
  );
  const t = await orch.run((await orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.notEqual(t.state, 'DONE');
  assert.ok(t.defects.some((d) => d.gate === 'test_integrity'));
});

test('high-risk plan waits for approval, then continues', async () => {
  const { orch } = await setup(
    baseHandlers({
      architect: (req) =>
        req.prompt.includes(': specification')
          ? { title: 'x', requirements: [{ id: 'REQ-01', description: 'subtract', acceptanceCriteria: ['5-3=2'] }], ambiguities: [], assumptions: [] }
          : { summary: 's', filesToChange: ['src/math.js', 'migrations/001_add.sql'], modules: [], risks: [], plan: ['p'], touchesDatabase: true, touchesAuth: false, touchesPublicApi: false },
    }),
  );
  const id = (await orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id;
  let t = await orch.run(id);
  assert.equal(t.state, 'AWAITING_APPROVAL');
  assert.equal(t.approval!.kind, 'high_risk');
  await orch.approve(id, 'ok, migration is fine');
  t = await orch.run(id);
  assert.equal(t.state, 'DONE', t.stopReason ?? "");
  assert.ok(t.humanInput.some((h) => h.text.includes('migration')));
});

test('blocking ambiguity pauses at SPECIFICATION and the answer reaches the architect', async () => {
  let specCalls = 0;
  const { orch, runner } = await setup(
    baseHandlers({
      architect: (req) => {
        if (!req.prompt.includes(': specification')) return (baseHandlers().architect as any)(req);
        specCalls++;
        return { title: 'x', requirements: [{ id: 'REQ-01', description: 'subtract', acceptanceCriteria: ['5-3=2'] }], ambiguities: [{ question: 'Floats too?', blocking: true }], assumptions: [] };
      },
    }),
  );
  const id = (await orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id;
  assert.equal((await orch.run(id)).state, 'AWAITING_APPROVAL');
  await orch.approve(id, 'Integers only');
  const t = await orch.run(id);
  assert.equal(t.state, 'DONE', t.stopReason ?? "");
  assert.equal(specCalls, 2);
  assert.ok(runner.calls.filter((c) => c.role === 'architect').some((c) => c.prompt.includes('Integers only')));
});

test('crash recovery: a new orchestrator process continues from persisted state', async () => {
  const env = await setup();
  const id = (await env.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id;
  for (let i = 0; i < 4; i++) await env.orch.step(id); // QUEUED..IMPACT done
  assert.equal((await env.store.getTask(id))!.state, 'IMPLEMENTATION');
  await env.store.close();

  // "Restart": fresh store instance from the same file, fresh orchestrator.
  const store2 = new MemoryStore(join(env.dataDir, 'state.json'));
  await store2.init();
  const runner2 = new ScriptedAgentRunner(baseHandlers());
  const orch2 = new Orchestrator({ store: store2, runner: runner2, dataDir: env.dataDir, workerId: 'other-worker' });
  const t = await orch2.run(id);
  assert.equal(t.state, 'DONE', t.stopReason ?? "");
  assert.deepEqual(runner2.calls.map((c) => c.role), ['developer', 'qa', 'reviewer'], 'did not redo research/spec');
});

test('budget limit stops the task', async () => {
  const { orch } = await setup(baseHandlers(), POLICY.replace('limits:\n', 'limits:\n  max_task_cost_usd: 0.03\n'));
  const t = await orch.run((await orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t.state, 'BLOCKED');
  assert.match(t.stopReason!, /budget exhausted/);
});

test('subscription usage limit pauses the task (no failure), then resumes the same session', async () => {
  const { orch, store, runner } = await setup();
  let limited = true;
  const seen: (string | undefined)[] = [];
  const inner = runner.run.bind(runner);
  (runner as any).run = async (req: any) => {
    if (req.role === 'developer') {
      seen.push(req.resumeSessionId);
      if (limited) {
        limited = false;
        await req.onSession?.('sess-dev-1');
        return { ok: false, text: '', costUsd: 0.2, numTurns: 2, subtype: 'rate_limited', toolCalls: 1, denied: [], rateLimitedUntil: Date.now() + 3_600_000, sessionId: 'sess-dev-1' };
      }
    }
    return inner(req);
  };
  const id = (await orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id;
  let t = await orch.run(id);
  assert.equal(t.state, 'IMPLEMENTATION');
  assert.ok(t.pausedUntil);
  assert.deepEqual(t.stepFailures.IMPLEMENTATION ?? 0, 0, 'usage limit is not a failure');
  assert.equal(await orch.step(id), 'paused');
  assert.equal((await store.listAgentRuns(id)).find((r) => r.role === 'developer')!.status, 'interrupted');

  // Window "resets".
  await store.saveTask({ ...t, pausedUntil: new Date(Date.now() - 1000).toISOString() }, t.version);
  t = await orch.run(id);
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  assert.equal(t.pausedUntil, undefined);
  assert.deepEqual(seen, [undefined, 'sess-dev-1'], 'interrupted session was resumed');
});
