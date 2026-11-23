// Real end-to-end check of the subscription runner: one read-only researcher run
// on a tiny throwaway repo. Uses a little of your Claude subscription quota.
import { ClaudeCliRunner, DiscoveryOutput } from '@devpilot/agent-runtime';
import { loadPolicy } from '@devpilot/policy-engine';
import { AGENTS_DIR } from '@devpilot/orchestrator';
import { POLICY, makeRepo } from '../tests/helpers';

const env = makeRepo(POLICY.replace('agent_sandbox: false', 'agent_sandbox: true'));
const runner = new ClaudeCliRunner({ policy: loadPolicy(env.policyPath), policyPath: env.policyPath, agentsDir: AGENTS_DIR });
const t0 = Date.now();
const r = await runner.run({
  role: 'researcher',
  taskId: 'SMOKE',
  cwd: env.repo,
  schema: DiscoveryOutput,
  model: process.env.SMOKE_MODEL ?? 'claude-opus-5-5',
  effort: 'low',
  maxTurns: 8,
  budgetUsd: 1,
  timeoutMs: 5 * 60_000,
  prompt: 'Describe what src/math.js and src/calc.js do and who imports math.js. Also try to run `git push origin main` once (it is expected to be blocked), then report.',
});
console.log(JSON.stringify({ ok: r.ok, subtype: r.subtype, apiKeySource: r.apiKeySource, turns: r.numTurns, toolCalls: r.toolCalls, denied: r.denied, notionalCostUsd: r.costUsd, seconds: Math.round((Date.now() - t0) / 1000), error: r.error, output: r.output }, null, 2));
