import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POLICY, baseHandlers, setup, writeSubtract } from './helpers';

process.env.DEVPILOT_GH_BIN = join(import.meta.dirname, 'fixtures/fake-gh.mjs');

const PR_POLICY = POLICY.replace('delivery: { create_pr: false }', 'delivery: { create_pr: true, require_ci: true, ci_poll_seconds: 0.05, ci_no_checks_grace_minutes: 1 }');

async function prSetup(checks: string[], handlers = baseHandlers(), policy = PR_POLICY) {
  const ghDir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  process.env.FAKE_GH_DIR = ghDir;
  writeFileSync(join(ghDir, 'checks.json'), JSON.stringify(checks));
  const env = await setup(handlers, policy);
  const bare = join(env.root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: env.repo });
  const remoteHead = (branch: string) => execFileSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: bare }).toString().trim();
  const pr = () => JSON.parse(readFileSync(join(ghDir, 'pr.json'), 'utf8'));
  const calls = () => readFileSync(join(ghDir, 'calls.log'), 'utf8').trim().split('\n');
  return { ...env, ghDir, remoteHead, pr, calls };
}

test('PR is opened for the verified commit and DONE waits for CI to go green', async () => {
  const e = await prSetup(['none', 'pending', 'pass']);
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id, { waitOnPause: true });
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  assert.equal(t.prUrl, 'https://github.com/acme/sample/pull/7');
  assert.equal(e.remoteHead(t.branch!), t.headCommit, 'pushed exactly the verified commit');
  assert.equal(t.gates.ci!.status, 'passed');
  assert.equal(t.gates.ci!.commit, t.headCommit);
  assert.equal(e.pr().base, 'main');
  assert.match(e.pr().body, /Quality gates/);
  const polls = (await e.store.listEvents(t.id)).filter((x) => x.type === 'ci_polled').map((x) => x.data.state);
  assert.deepEqual(polls, ['none', 'pending', 'pass']);
});

test('red CI goes back to repair, the fix is re-verified, pushed and CI re-checked', async () => {
  let fixerPrompt = '';
  const e = await prSetup(
    ['fail', 'pass'],
    baseHandlers({
      fixer: (req) => {
        fixerPrompt = req.prompt;
        writeSubtract(req.cwd, '(a - b) // CI fix');
        return { summary: 'fixed for CI', defectsAddressed: [] };
      },
    }),
  );
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id, { waitOnPause: true });
  assert.match(fixerPrompt, /CI check "test" failed/);
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  assert.equal(t.repairAttempts, 1);
  const ciDefect = t.defects.find((d) => d.gate === 'ci')!;
  assert.ok(ciDefect.resolved);
  assert.match(ciDefect.details, /expected: 6/, 'failed Actions log reached the defect');
  assert.equal(e.remoteHead(t.branch!), t.headCommit, 'repair commit was pushed');
  assert.equal(e.pr().edited, 1, 'PR description refreshed with the new report');
  assert.equal(e.calls().filter((c) => c === 'pr create').length, 1, 'PR created only once');
  const states = (await e.store.listEvents(t.id)).filter((x) => x.type === 'state_changed').map((x) => x.data.to);
  assert.ok(states.join(',').includes('DELIVERY,REPAIR,VALIDATION,REVIEW,DELIVERY,DONE'));
});

test('no CI configured on the repo: NOT_VERIFIED -> BLOCKED, never DONE', async () => {
  const e = await prSetup(['none'], baseHandlers(), PR_POLICY.replace('ci_no_checks_grace_minutes: 1', 'ci_no_checks_grace_minutes: 0.000001'));
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id, { waitOnPause: true });
  assert.equal(t.state, 'BLOCKED');
  assert.equal(t.gates.ci!.status, 'not_verified');
  assert.match(t.stopReason!, /no CI checks were reported/);
});

test('require_ci: false finishes right after opening the PR', async () => {
  const e = await prSetup(['none'], baseHandlers(), PR_POLICY.replace('require_ci: true', 'require_ci: false'));
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t.state, 'DONE');
  assert.ok(t.prUrl);
  assert.equal(t.gates.ci, undefined);
});

test('create_pr without a remote blocks instead of silently delivering locally', async () => {
  const env = await setup(baseHandlers(), PR_POLICY);
  const t = await env.orch.run((await env.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t.state, 'BLOCKED');
  assert.match(t.stopReason!, /no remote "origin"/);
});
