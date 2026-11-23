import type { z } from 'zod';
import type { AgentRole } from '@devpilot/shared';

export interface AgentRequest<T> {
  role: AgentRole;
  taskId: string;
  prompt: string;
  cwd: string;
  schema: z.ZodType<T>;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTurns: number;
  budgetUsd: number;
  timeoutMs: number;
  resumeSessionId?: string;
  /** Called as soon as the SDK reports a session id, so it can be persisted before the run ends. */
  onSession?: (sessionId: string) => void | Promise<void>;
  onToolDenied?: (tool: string, reason: string) => void;
}

export interface AgentResult<T> {
  ok: boolean;
  output?: T;
  text: string;
  sessionId?: string;
  costUsd: number;
  numTurns: number;
  subtype: string;
  toolCalls: number;
  denied: { tool: string; reason: string }[];
  error?: string;
  /** Set when a subscription usage limit stopped the run: epoch ms when it resets. */
  rateLimitedUntil?: number;
  /** Where the credential came from, as reported by Claude Code ('none' = claude.ai login). */
  apiKeySource?: string;
}

/** Interchangeable "intelligent executor". The orchestrator does not care what is behind it. */
export interface AgentRunner {
  run<T>(req: AgentRequest<T>): Promise<AgentResult<T>>;
}

export type ScriptedHandler = (req: AgentRequest<unknown>) => unknown | Promise<unknown>;

/** Deterministic runner for tests and dry runs. Handlers may edit files in req.cwd. */
export class ScriptedAgentRunner implements AgentRunner {
  readonly calls: { role: AgentRole; prompt: string }[] = [];
  constructor(private readonly handlers: Partial<Record<AgentRole, ScriptedHandler>>) {}
  async run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
    this.calls.push({ role: req.role, prompt: req.prompt });
    const h = this.handlers[req.role];
    if (!h) return { ok: false, text: '', costUsd: 0, numTurns: 0, subtype: 'error', toolCalls: 0, denied: [], error: `no scripted handler for ${req.role}` };
    try {
      const raw = await h(req as AgentRequest<unknown>);
      const parsed = req.schema.safeParse(raw);
      if (!parsed.success) return { ok: false, text: JSON.stringify(raw), costUsd: 0, numTurns: 1, subtype: 'invalid_output', toolCalls: 0, denied: [], error: parsed.error.message };
      return { ok: true, output: parsed.data, text: JSON.stringify(raw), sessionId: `scripted-${req.role}`, costUsd: 0.01, numTurns: 1, subtype: 'success', toolCalls: 0, denied: [] };
    } catch (e: any) {
      return { ok: false, text: '', costUsd: 0, numTurns: 1, subtype: 'error', toolCalls: 0, denied: [], error: e?.message ?? String(e) };
    }
  }
}
