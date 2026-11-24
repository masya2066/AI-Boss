import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ClaudeCliRunner, DiscoveryOutput } from '@devpilot/agent-runtime';
import { loadPolicy } from '@devpilot/policy-engine';
import { AGENTS_DIR } from '@devpilot/orchestrator';
import { POLICY, makeRepo } from './helpers';

const FAKE = join(import.meta.dirname, 'fixtures/fake-claude.mjs');
// Test knobs for the fake binary must be passed through explicitly - everything else is scrubbed.
const env = makeRepo(POLICY.replace('execution: { agent_sandbox: false, mode: pipeline }', 'execution: { agent_sandbox: false, mode: pipeline, env_passthrough: [FAKE_KEY_SOURCE, FAKE_RATE_LIMIT, ANTHROPIC_API_KEY] }'));
const runner = new ClaudeCliRunner({ policy: loadPolicy(env.policyPath), policyPath: env.policyPath, agentsDir: AGENTS_DIR, claudeBin: FAKE });
const req = (o = {}) => ({ role: 'researcher' as const, taskId: 'T', prompt: 'look around', cwd: env.repo, schema: DiscoveryOutput, model: 'claude-opus-5-5', effort: 'high' as const, maxTurns: 5, budgetUsd: 1, timeoutMs: 60_000, ...o });

test('subscription runner: no API key leaks, policy hook denies, structured output parsed', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-pass';
  try {
    const sessions: string[] = [];
    const r = await runner.run(req({ onSession: (s: string) => void sessions.push(s) }));
    assert.equal(r.ok, true, r.error ?? "");
    assert.match(r.output!.summary, /apiKey=absent/);
    assert.match(r.output!.summary, /hookDenied=true/);
    assert.equal(r.denied.length, 1);
    assert.match(r.denied[0]!.reason, /deny rule/);
    assert.equal(r.apiKeySource, 'none');
    assert.equal(sessions[0], '11111111-2222-3333-4444-555555555555');
    assert.equal(r.toolCalls, 1);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('subscription runner refuses to run on an API key', async () => {
  process.env.FAKE_KEY_SOURCE = 'ANTHROPIC_API_KEY';
  try {
    const r = await runner.run(req());
    assert.equal(r.ok, false);
    assert.equal(r.subtype, 'auth_mismatch');
  } finally {
    delete process.env.FAKE_KEY_SOURCE;
  }
});

test('usage limit is reported with reset time, and resume passes the session id', async () => {
  process.env.FAKE_RATE_LIMIT = '1';
  try {
    const r = await runner.run(req());
    assert.equal(r.subtype, 'rate_limited');
    assert.ok(r.rateLimitedUntil! > Date.now() + 3_000_000);
  } finally {
    delete process.env.FAKE_RATE_LIMIT;
  }
  const r2 = await runner.run(req({ resumeSessionId: 'abc' }));
  assert.match(r2.output!.summary, /resume=abc/);
});
