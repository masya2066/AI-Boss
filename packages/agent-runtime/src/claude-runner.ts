import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { query, type HookCallback, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { checkToolUse, type LoadedPolicy } from '@devpilot/policy-engine';
import { scrubbedEnv } from '@devpilot/sandbox-manager';
import type { AgentRole } from '@devpilot/shared';
import type { AgentRequest, AgentResult, AgentRunner } from './runner';
import { toOutputSchema } from './schemas';

const AUTH_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_REGION', 'AWS_PROFILE'];

export interface ClaudeRunnerOptions {
  policy: LoadedPolicy;
  agentsDir: string;
  /** Extra text appended to every system prompt (e.g. org-wide rules). */
  extraSystemPrompt?: string;
}

/**
 * Runs one role as a Claude Code session via the Claude Agent SDK.
 * Safety layers, inside-out:
 *   1. PreToolUse hook + canUseTool -> policy-engine (role tools, path confinement, bash deny list)
 *   2. Claude Code OS sandbox for Bash (filesystem writes limited to the worktree)
 *   3. The worktree / container the orchestrator runs us in (outside the model's control)
 */
export class ClaudeAgentRunner implements AgentRunner {
  constructor(private readonly o: ClaudeRunnerOptions) {}

  private rolePrompt(role: AgentRole): string {
    const file = role === 'qa' ? 'qa-engineer' : role;
    const p = join(this.o.agentsDir, `${file}.md`);
    const body = existsSync(p) ? readFileSync(p, 'utf8') : `You are the ${role} agent.`;
    return [body, this.o.extraSystemPrompt].filter(Boolean).join('\n\n');
  }

  async run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
    const { policy } = this.o;
    const roleCfg = policy.permissions.roles[req.role];
    const denied: { tool: string; reason: string }[] = [];
    const ctx = { role: req.role, worktree: req.cwd, policy };

    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const d = checkToolUse(ctx, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
      if (d.allow) return {};
      denied.push({ tool: input.tool_name, reason: d.reason });
      req.onToolDenied?.(input.tool_name, d.reason);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `DevPilot policy: ${d.reason}`,
        },
      };
    };

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), req.timeoutMs);
    const options: Options = {
      cwd: req.cwd,
      model: req.model,
      effort: req.effort,
      maxTurns: req.maxTurns,
      maxBudgetUsd: req.budgetUsd,
      abortController: abort,
      tools: roleCfg?.tools ?? [],
      permissionMode: 'default',
      canUseTool: async (toolName, input) => {
        const d = checkToolUse(ctx, toolName, input);
        return d.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `DevPilot policy: ${d.reason}` };
      },
      hooks: { PreToolUse: [{ hooks: [preToolUse], onFailure: 'block' }] },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.rolePrompt(req.role) },
      // Load the target repo's CLAUDE.md / project settings, never the host user's settings.
      settingSources: ['project'],
      outputFormat: { type: 'json_schema', schema: toOutputSchema(req.schema) },
      env: scrubbedEnv([...AUTH_ENV, ...policy.project.execution.env_passthrough]),
      sandbox: policy.project.execution.agent_sandbox
        ? { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, filesystem: { allowWrite: [req.cwd] } }
        : undefined,
      persistSession: true,
      ...(req.resumeSessionId ? { resume: req.resumeSessionId } : {}),
    };

    let sessionId: string | undefined;
    let toolCalls = 0;
    let costUsd = 0;
    let numTurns = 0;
    let subtype = 'unknown';
    let text = '';
    let structured: unknown;
    let error: string | undefined;

    try {
      for await (const msg of query({ prompt: req.prompt, options }) as AsyncIterable<SDKMessage>) {
        if (!sessionId && 'session_id' in msg && typeof msg.session_id === 'string') {
          sessionId = msg.session_id;
          await req.onSession?.(sessionId);
        }
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) if (block.type === 'tool_use') toolCalls++;
        }
        if (msg.type === 'result') {
          costUsd = msg.total_cost_usd;
          numTurns = msg.num_turns;
          subtype = msg.subtype;
          if (msg.subtype === 'success') {
            text = msg.result;
            structured = msg.structured_output;
          } else {
            error = msg.errors?.join('; ') || msg.subtype;
          }
        }
      }
    } catch (e: any) {
      error = abort.signal.aborted ? `timed out after ${req.timeoutMs}ms` : (e?.message ?? String(e));
      subtype = abort.signal.aborted ? 'timeout' : 'exception';
    } finally {
      clearTimeout(timer);
    }

    const base = { text, sessionId, costUsd, numTurns, subtype, toolCalls, denied };
    if (error || subtype !== 'success') return { ok: false, ...base, error: error ?? subtype };
    let candidate = structured;
    if (candidate === undefined) {
      try {
        candidate = JSON.parse(text);
      } catch {
        /* fallthrough */
      }
    }
    const parsed = req.schema.safeParse(candidate);
    if (!parsed.success) return { ok: false, ...base, subtype: 'invalid_output', error: `structured output invalid: ${parsed.error.message}` };
    return { ok: true, ...base, output: parsed.data };
  }
}
