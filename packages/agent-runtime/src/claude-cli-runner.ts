import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { LoadedPolicy } from '@devpilot/policy-engine';
import { scrubbedEnv } from '@devpilot/sandbox-manager';
import type { AgentRole } from '@devpilot/shared';
import { activityOf, type AgentRequest, type AgentResult, type AgentRunner } from './runner';
import { toOutputSchema } from './schemas';

/** Agents started by this process: they must not outlive it (an orphan would keep editing the worktree). */
const LIVE = new Set<ChildProcess>();
let hooked = false;
function track(child: ChildProcess) {
  LIVE.add(child);
  child.once('close', () => LIVE.delete(child));
  if (hooked) return;
  hooked = true;
  const killAll = () => {
    for (const c of LIVE) c.kill('SIGKILL');
  };
  process.once('exit', killAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.once(sig, () => {
      killAll();
      if (process.listenerCount(sig) === 0) process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const)[sig]);
    });
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const HOOK_SCRIPT = join(HERE, 'policy-hook.ts');
const TSX_CLI = join(ROOT, 'node_modules/tsx/dist/cli.mjs');

export interface ClaudeCliRunnerOptions {
  policy: LoadedPolicy;
  policyPath?: string;
  policiesDir?: string;
  agentsDir: string;
  /** Path to the `claude` binary. Default: DEVPILOT_CLAUDE_BIN or `claude` on PATH. */
  claudeBin?: string;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Runs a role through the official Claude Code CLI in headless mode:
 *   claude -p --output-format stream-json --json-schema … --settings {hooks, sandbox}
 * This uses whatever the local `claude` is logged in with — your Claude
 * subscription (`claude login`) or CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`).
 * ANTHROPIC_API_KEY is never passed, so it cannot take precedence over the login.
 */
export class ClaudeCliRunner implements AgentRunner {
  constructor(private readonly o: ClaudeCliRunnerOptions) {}

  private rolePrompt(role: AgentRole) {
    const file = role === 'qa' ? 'qa-engineer' : role;
    const p = join(this.o.agentsDir, `${file}.md`);
    return existsSync(p) ? readFileSync(p, 'utf8') : `You are the ${role} agent.`;
  }

  async run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
    const { policy } = this.o;
    const roleCfg = policy.permissions.roles[req.role];
    const tmp = mkdtempSync(join(tmpdir(), 'devpilot-run-'));
    const denyLog = join(tmp, 'denied.jsonl');
    const ex = policy.project.execution;

    const hookCmd = `${q(process.execPath)} ${q(TSX_CLI)} ${q(HOOK_SCRIPT)}`;
    const settings = {
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCmd, timeout: 30 }] }] },
      ...(ex.agent_sandbox ? { sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, filesystem: { allowWrite: [req.cwd] } } } : {}),
    };
    const settingsPath = join(tmp, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(settings));

    const tools = roleCfg?.tools ?? [];
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', req.model,
      '--effort', req.effort,
      '--max-turns', String(req.maxTurns),
      '--permission-mode', 'default',
      '--setting-sources', 'project',
      '--settings', settingsPath,
      '--strict-mcp-config',
      '--append-system-prompt', this.rolePrompt(req.role),
      '--json-schema', JSON.stringify(toOutputSchema(req.schema)),
      '--tools', tools.join(','),
      '--allowedTools', tools.join(','),
    ];
    if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);

    const env: Record<string, string> = scrubbedEnv(ex.env_passthrough, {
      DEVPILOT_ROLE: req.role,
      DEVPILOT_WORKTREE: req.cwd,
      DEVPILOT_POLICY_PATH: this.o.policyPath ?? '',
      DEVPILOT_POLICIES_DIR: this.o.policiesDir ?? '',
      DEVPILOT_DENY_LOG: denyLog,
    });
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const bin = this.o.claudeBin ?? process.env.DEVPILOT_CLAUDE_BIN ?? 'claude';
    let sessionId: string | undefined;
    let apiKeySource: string | undefined;
    let toolCalls = 0;
    let costUsd = 0;
    let numTurns = 0;
    let subtype = 'unknown';
    let text = '';
    let structured: unknown;
    let error: string | undefined;
    let rateLimitedUntil: number | undefined;
    let stderr = '';

    const child = spawn(bin, args, { cwd: req.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    track(child);
    if (req.pidFile && child.pid) writeFileSync(req.pidFile, `${child.pid}\n${bin}\n`);
    child.stdin.end(req.prompt);
    child.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString()).slice(-8000)));
    const timer = setTimeout(() => {
      error = `timed out after ${req.timeoutMs}ms`;
      subtype = 'timeout';
      child.kill('SIGKILL');
    }, req.timeoutMs);

    const rl = createInterface({ input: child.stdout });
    for await (const line of rl) {
      if (!line.trim().startsWith('{')) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!sessionId && typeof msg.session_id === 'string') {
        sessionId = msg.session_id;
        await req.onSession?.(msg.session_id);
      }
      if (msg.type === 'system' && msg.subtype === 'init') {
        apiKeySource = msg.apiKeySource;
        // Guard: subscription mode must never bill an API key.
        if (apiKeySource && apiKeySource !== 'none') {
          error = `refusing to run: Claude Code is using an API key (${apiKeySource}) instead of your subscription login`;
          subtype = 'auth_mismatch';
          child.kill('SIGKILL');
        }
      }
      if (msg.type === 'rate_limit_event' && msg.rate_limit_info?.status === 'rejected') {
        const r = msg.rate_limit_info.resetsAt;
        rateLimitedUntil = typeof r === 'number' ? (r < 1e12 ? r * 1000 : r) : Date.now() + 15 * 60_000;
      }
      if (msg.type === 'assistant') {
        if (msg.error === 'rate_limit' && !rateLimitedUntil) rateLimitedUntil = Date.now() + 15 * 60_000;
        for (const b of msg.message?.content ?? [])
          if (b.type === 'tool_use') {
            toolCalls++;
            if (b.name !== 'StructuredOutput') req.onActivity?.(activityOf(b.name, b.input));
          }
      }
      if (msg.type === 'result') {
        costUsd = msg.total_cost_usd ?? 0;
        numTurns = msg.num_turns ?? 0;
        if (subtype !== 'auth_mismatch') subtype = msg.subtype;
        if (msg.subtype === 'success' && !msg.is_error) {
          text = msg.result ?? '';
          structured = msg.structured_output;
        } else error ??= (msg.errors ?? []).join('; ') || msg.result || msg.subtype;
      }
    }
    const code: number | null = await new Promise((r) => (child.exitCode !== null ? r(child.exitCode) : child.on('close', r)));
    clearTimeout(timer);
    if (req.pidFile) rmSync(req.pidFile, { force: true });

    const denied = existsSync(denyLog)
      ? readFileSync(denyLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string; reason: string })
      : [];
    for (const d of denied) req.onToolDenied?.(d.tool, d.reason);
    rmSync(tmp, { recursive: true, force: true });

    const base = { text, sessionId, costUsd, numTurns, subtype, toolCalls, denied, apiKeySource, rateLimitedUntil };
    if (rateLimitedUntil) return { ok: false, ...base, subtype: 'rate_limited', error: `usage limit reached, resets ${new Date(rateLimitedUntil).toISOString()}` };
    if (error || subtype !== 'success') return { ok: false, ...base, error: error ?? `claude exited ${code}: ${stderr.slice(-1000)}` };
    let candidate = structured;
    if (candidate === undefined) {
      try {
        candidate = JSON.parse(text);
      } catch {
        /* not JSON */
      }
    }
    const parsed = req.schema.safeParse(candidate);
    if (!parsed.success) return { ok: false, ...base, subtype: 'invalid_output', error: `structured output invalid: ${parsed.error.message}` };
    return { ok: true, ...base, output: parsed.data };
  }
}
