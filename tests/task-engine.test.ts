import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, transition } from '@devpilot/task-engine';
import type { Task } from '@devpilot/shared';

const base = (o: Partial<Task> = {}): Task => ({
  id: 'T', projectId: 'p', title: 't', prompt: 'p', state: 'VALIDATION', version: 1, requirements: [], gates: {}, defects: [], repairAttempts: 0, costUsd: 0,
  approvalsGranted: [], humanInput: [], assumptions: [], checkpoints: {}, repairHistory: [], extraRepairAttempts: 0, resumedAtAttempt: 0, stepFailures: {},
  createdAt: '', updatedAt: '', worktreePath: '/tmp/x', ...o,
});
const passed = (name: string, commit: string) => ({ name, status: 'passed' as const, required: true, commit, ranAt: '' });

test('illegal edges are rejected', () => {
  assert.equal(canTransition(base({ state: 'QUEUED' }), 'DONE', { headCommit: 'a' }).ok, false);
  assert.equal(canTransition(base({ state: 'DISCOVERY' }), 'IMPLEMENTATION', { headCommit: 'a' }).ok, false);
  assert.equal(canTransition(base({ state: 'DONE' }), 'REPAIR', { headCommit: 'a' }).ok, false);
});

test('delivery requires every required gate passed at the current HEAD', () => {
  const t = base({ gates: { unit_tests: passed('unit_tests', 'aaa'), independent_review: passed('independent_review', 'aaa') } });
  assert.equal(canTransition(t, 'DELIVERY', { headCommit: 'aaa' }).ok, true);
  const stale = canTransition(t, 'DELIVERY', { headCommit: 'bbb' });
  assert.equal(stale.ok, false);
  assert.match((stale as any).reason, /stale/);
  const failed = base({ gates: { unit_tests: { ...passed('unit_tests', 'aaa'), status: 'failed' } } });
  assert.throws(() => transition(failed, 'DELIVERY', { headCommit: 'aaa' }), /required gates not passed/);
});

test('no gates at all is not a pass', () => {
  assert.equal(canTransition(base(), 'DELIVERY', { headCommit: 'a' }).ok, false);
});

test('review may start before the review gate exists, delivery may not', () => {
  const t = base({ gates: { unit_tests: passed('unit_tests', 'a'), independent_review: { ...passed('independent_review', 'a'), status: 'pending' } } });
  assert.equal(canTransition(t, 'REVIEW', { headCommit: 'a' }).ok, true);
  assert.equal(canTransition(t, 'DELIVERY', { headCommit: 'a' }).ok, false);
});
