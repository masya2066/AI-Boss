/**
 * PreToolUse command hook for headless `claude -p` runs.
 * Claude Code pipes the hook event as JSON on stdin; we answer with a
 * permission decision. Context comes from env vars set by ClaudeCliRunner.
 * Any error => deny (fail closed).
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { checkToolUse, loadPolicy } from '@devpilot/policy-engine';
import type { AgentRole } from '@devpilot/shared';

function out(decision: 'allow' | 'deny', reason?: string): never {
  if (decision === 'deny') {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `DevPilot policy: ${reason}` } }),
    );
  }
  process.exit(0);
}

try {
  const ev = JSON.parse(readFileSync(0, 'utf8')) as { tool_name: string; tool_input?: Record<string, unknown> };
  const role = process.env.DEVPILOT_ROLE as AgentRole;
  const worktree = process.env.DEVPILOT_WORKTREE!;
  const policy = loadPolicy(process.env.DEVPILOT_POLICY_PATH || undefined, process.env.DEVPILOT_POLICIES_DIR || undefined);
  const d = checkToolUse({ role, worktree, policy }, ev.tool_name, ev.tool_input ?? {});
  if (d.allow) out('allow');
  if (process.env.DEVPILOT_DENY_LOG) appendFileSync(process.env.DEVPILOT_DENY_LOG, JSON.stringify({ tool: ev.tool_name, reason: d.reason }) + '\n');
  out('deny', d.reason);
} catch (e: any) {
  out('deny', `policy hook error: ${e?.message ?? e}`);
}
