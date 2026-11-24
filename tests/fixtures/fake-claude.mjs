#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json`, used by tests.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (n) => args[args.indexOf(n) + 1];
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const prompt = readFileSync(0, 'utf8');
const sid = '11111111-2222-3333-4444-555555555555';

emit({ type: 'system', subtype: 'init', session_id: sid, apiKeySource: process.env.FAKE_KEY_SOURCE ?? 'none', model: arg('--model') });

// Simulate Claude Code invoking our PreToolUse hook for a forbidden command.
const settings = JSON.parse(readFileSync(arg('--settings'), 'utf8'));
const hook = settings.hooks.PreToolUse[0].hooks[0].command;
const ev = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } });
const out = execSync(hook, { input: ev, env: process.env }).toString();
const denied = out.includes('"deny"');
emit({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });

if (process.env.FAKE_RATE_LIMIT) {
  emit({ type: 'rate_limit_event', session_id: sid, rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' } });
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, total_cost_usd: 0, num_turns: 1, errors: ['rate limited'] });
  process.exit(1);
}
emit({
  type: 'result', subtype: 'success', is_error: false, session_id: sid, total_cost_usd: 0.12, num_turns: 3, result: 'done',
  structured_output: {
    summary: `apiKey=${process.env.ANTHROPIC_API_KEY ? 'LEAKED' : 'absent'} hookDenied=${denied} resume=${arg('--resume') ?? '-'} promptLen=${prompt.length}`,
    relevantFiles: [], existingPatterns: [], risks: [], searchTerms: [],
  },
});
