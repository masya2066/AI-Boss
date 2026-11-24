import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '@devpilot/shared';
import { setup } from './helpers';
import { CODE, PAR_POLICY, SUBTASKS, handlers } from './fixtures/subtask-plan';

const children = async (store: any, t: Task): Promise<Task[]> => Promise.all(t.subtasks!.map((s) => store.getTask(s.taskId)));
const gitc = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd }).toString().trim();

test('large task: DAG of subtasks runs in parallel worktrees, is integrated and re-verified as a whole', async () => {
  const log: { key: string; start: number; end: number }[] = [];
  const e = await setup(handlers({ log }), PAR_POLICY);
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Math v2: subtract, multiply, diff' })).id);
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  const kids = await children(e.store, t);
  assert.deepEqual(kids.map((k: Task) => k.state), ['DONE', 'DONE', 'DONE']);
  // S1 and S2 overlapped; never more than 2 developers at once; S3 started after S1 was integrated.
  const [s1, s2, s3] = ['S1', 'S2', 'S3'].map((k) => log.find((l) => l.key === k)!);
  assert.ok(s1!.start < s2!.end && s2!.start < s1!.end, 'S1 and S2 ran concurrently');
  assert.ok(s3!.start >= s1!.end, 'S3 waited for its dependency');
  const s1Commit = t.subtasks!.find((s) => s.key === 'S1')!.integratedCommit!;
  execFileSync('git', ['merge-base', '--is-ancestor', s1Commit, kids[2]!.baseCommit!], { cwd: e.repo });
  // The integrated branch contains every part, and the parent's own gates/review ran on it.
  const wt = t.worktreePath!;
  assert.match(readFileSync(join(wt, 'src/math.js'), 'utf8'), /subtract/);
  assert.ok(existsSync(join(wt, 'src/ops.js')));
  assert.match(readFileSync(join(wt, 'src/calc.js'), 'utf8'), /diff/);
  for (const g of Object.values(t.gates).filter((g) => g.required)) assert.equal(g.status, 'passed', `${g.name}: ${g.reason}`);
  assert.deepEqual(t.requirements.map((r) => r.status), ['covered', 'covered', 'covered']);
  const reviews = e.runner.calls.filter((c) => c.role === 'reviewer').length;
  assert.equal(reviews, 4, '3 subtask reviews + 1 review of the integrated result');
  const evs = (await e.store.listEvents(t.id)).map((x) => x.type);
  assert.equal(evs.filter((x) => x === 'subtask_integrated').length, 3);
  assert.match(readFileSync(t.reportPath!, 'utf8'), /## Subtasks/);
  assert.equal(gitc(wt, 'status', '--porcelain'), '');
});

test('parallel parts that collide in one file: integrator resolves, result is re-verified', async () => {
  const both = [
    { key: 'S1', title: 'subtract', description: 'd', requirementIds: ['REQ-01'], files: ['src/math.js'], dependsOn: [] },
    { key: 'S2', title: 'multiply', description: 'd', requirementIds: ['REQ-02', 'REQ-03'], files: ['src/ops.js', 'src/calc.js'], dependsOn: [] },
  ];
  let integratorCalls = 0;
  const e = await setup(
    handlers({
      subtasks: both,
      code: {
        S1: CODE.S1!,
        // S2 unexpectedly also appends to math.js -> conflict on integration
        S2: (cwd) => (appendFileSync(join(cwd, 'src/math.js'), '\nexport const PI2 = 6.28;\n'), CODE.S2!(cwd), writeFileSync(join(cwd, 'src/calc.js'), "import { add } from './math.js';\nexport const sum = (xs) => xs.reduce(add, 0);\nexport const diff = (xs) => xs.reduce((a, b) => a - b);\n")),
      },
      over: {
        integrator: (req) => {
          integratorCalls++;
          const f = join(req.cwd, 'src/math.js');
          writeFileSync(f, readFileSync(f, 'utf8').replace(/<<<<<<< [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g, '$1$2'));
          return { summary: 'kept both', resolvedFiles: ['src/math.js'] };
        },
      },
    }),
    PAR_POLICY,
  );
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Math v2' })).id);
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  assert.equal(integratorCalls, 1);
  const math = readFileSync(join(t.worktreePath!, 'src/math.js'), 'utf8');
  assert.match(math, /subtract/);
  assert.match(math, /PI2/);
  assert.doesNotMatch(math, /<<<<<<<|>>>>>>>/);
  assert.ok((await e.store.listEvents(t.id)).some((x) => x.type === 'integration_conflict_resolved'));
  assert.deepEqual(t.subtasks!.find((s) => s.key === 'S2')!.conflicts, ['src/math.js']);
});

test('declared file overlap is serialized up front: no conflict, no integrator', async () => {
  const overlap = [
    { key: 'S1', title: 'subtract', description: 'd', requirementIds: ['REQ-01'], files: ['src/math.js'], dependsOn: [] },
    { key: 'S2', title: 'more math', description: 'd', requirementIds: ['REQ-02', 'REQ-03'], files: ['src/math.js', 'src/ops.js', 'src/calc.js'], dependsOn: [] },
  ];
  let integratorCalls = 0;
  const e = await setup(
    handlers({
      subtasks: overlap,
      code: { S1: CODE.S1!, S2: (cwd) => (appendFileSync(join(cwd, 'src/math.js'), '\nexport const PI2 = 6.28;\n'), CODE.S2!(cwd), CODE.S3!(cwd)) },
      over: { integrator: () => (integratorCalls++, { summary: '', resolvedFiles: [] }) },
    }),
    PAR_POLICY,
  );
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Math v2' })).id);
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  assert.equal(integratorCalls, 0);
  assert.deepEqual(t.subtasks!.find((s) => s.key === 'S2')!.dependsOn, ['S1']);
  const ev = (await e.store.listEvents(t.id)).find((x) => x.type === 'plan_validated')!;
  assert.deepEqual(ev.data.serialized, [{ key: 'S2', after: 'S1', files: ['src/math.js'] }]);
});

test('a failed subtask blocks the parent; cancelling the parent cancels its subtasks', async () => {
  const e = await setup(handlers({ code: { ...CODE, S2: (cwd) => writeFileSync(join(cwd, 'src/ops.js'), 'export const multiply = (a, b) => a + b;\n') } }), PAR_POLICY);
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Math v2' })).id);
  assert.equal(t.state, 'BLOCKED');
  assert.match(t.stopReason!, /subtask S2 \(TASK-[A-Z0-9]+\) is BLOCKED/);
  await e.orch.cancel(t.id);
  const kids = (await children(e.store, (await e.store.getTask(t.id))!)).filter(Boolean);
  for (const k of kids) assert.ok(['DONE', 'CANCELLED'].includes(k.state), `${k.subtaskKey} ${k.state}`);
});

test('invalid plans are rejected deterministically (cycle / uncovered requirement)', async () => {
  const cyc = SUBTASKS.map((s) => (s.key === 'S1' ? { ...s, dependsOn: ['S3'] } : s));
  const e = await setup(handlers({ subtasks: cyc }), PAR_POLICY);
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Math v2' })).id);
  assert.equal(t.state, 'BLOCKED');
  assert.match(t.stopReason!, /invalid subtask plan: dependency cycle/);
  const e2 = await setup(handlers({ subtasks: SUBTASKS.slice(0, 2) }), PAR_POLICY);
  const t2 = await e2.orch.run((await e2.orch.createTask({ projectId: 'sample', prompt: 'Math v2' })).id);
  assert.match(t2.stopReason!, /not covered by any subtask: REQ-03/);
});

test('unresolvable conflict: merge is aborted and the parent blocks with a clean worktree', async () => {
  const both = [
    { key: 'S1', title: 'a', description: 'd', requirementIds: ['REQ-01'], files: ['src/math.js'], dependsOn: [] },
    { key: 'S2', title: 'b', description: 'd', requirementIds: ['REQ-02', 'REQ-03'], files: ['src/ops.js'], dependsOn: [] },
  ];
  const e = await setup(
    handlers({ subtasks: both, code: { S1: CODE.S1!, S2: (cwd) => (appendFileSync(join(cwd, 'src/math.js'), '\nexport const X = 1;\n'), CODE.S2!(cwd), appendFileSync(join(cwd, 'src/calc.js'), 'export const diff = (xs) => xs.reduce((a, b) => a - b);\n')) }, over: { integrator: () => ({ summary: 'gave up', resolvedFiles: [] }) } }),
    PAR_POLICY,
  );
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Math v2' })).id);
  assert.equal(t.state, 'BLOCKED');
  assert.match(t.stopReason!, /could not resolve merge conflicts integrating S2/);
  assert.equal(gitc(t.worktreePath!, 'status', '--porcelain'), '');
  assert.equal(e.runner.calls.filter((c) => c.role === 'integrator').length, 2, 'max_conflict_attempts');
});

test('worker mode: spawned subtasks are handed to the scheduler hook, limited by parallelism', async () => {
  const e = await setup(handlers(), PAR_POLICY);
  const ready: string[] = [];
  e.orch.setTaskReadyHook(async (id) => void ready.push(id));
  const id = (await e.orch.createTask({ projectId: 'sample', prompt: 'Math v2' })).id;
  for (let i = 0; i < 8 && (await e.store.getTask(id))!.state !== 'EXECUTING_SUBTASKS'; i++) await e.orch.step(id);
  assert.equal(await e.orch.step(id), 'paused');
  const t = (await e.store.getTask(id))!;
  assert.equal(t.waitReason, 'subtasks');
  assert.deepEqual(ready, t.subtasks!.filter((s) => s.taskId).map((s) => s.taskId));
  assert.equal(ready.length, 2, 'S1, S2 now; S3 waits for S1');
  // a finished child wakes the parent up
  await e.orch.run(ready[0]!);
  assert.ok(ready.includes(id), 'parent re-scheduled when its subtask finished');
});
