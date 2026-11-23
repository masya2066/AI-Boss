import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { AgentRole } from '@devpilot/shared';
import {
  PermissionsSchema,
  ProjectPolicySchema,
  type GateRule,
  type Permissions,
  type ProjectPolicy,
} from './schema';

export * from './schema';

export const DEFAULT_POLICIES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../policies');

// ---------------------------------------------------------------------------
// Globs (gitignore-like: a pattern without "/" matches the basename anywhere)
// ---------------------------------------------------------------------------
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(filePath: string, globs: string[]): boolean {
  const p = filePath.split(sep).join('/').replace(/^\.\//, '');
  const base = p.split('/').pop() ?? p;
  return globs.some((g) => {
    const rx = globToRegExp(g);
    return rx.test(p) || (!g.includes('/') && rx.test(base));
  });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
function readYaml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return (YAML.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) ?? {};
}

function deepMerge<T>(base: T, over: unknown): T {
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = typeof b === 'object' && b !== null && !Array.isArray(b) ? deepMerge(b, v) : v;
  }
  return out as T;
}

export interface LoadedPolicy {
  project: ProjectPolicy;
  permissions: Permissions;
}

/**
 * Global defaults (policies/quality-gates.yaml, budgets.yaml) <- project YAML.
 * Permissions are global (policies/permissions.yaml) and can't be relaxed per project.
 */
export function loadPolicy(projectPolicyPath?: string, policiesDir = DEFAULT_POLICIES_DIR): LoadedPolicy {
  const gates = readYaml(join(policiesDir, 'quality-gates.yaml'));
  const budgets = readYaml(join(policiesDir, 'budgets.yaml'));
  const proj = projectPolicyPath ? readYaml(projectPolicyPath) : {};
  const merged = deepMerge(deepMerge(gates, budgets), proj);
  return {
    project: ProjectPolicySchema.parse(merged),
    permissions: PermissionsSchema.parse(readYaml(join(policiesDir, 'permissions.yaml'))),
  };
}

// ---------------------------------------------------------------------------
// Gate selection: which checks are mandatory for this change
// ---------------------------------------------------------------------------
export interface GatePlan {
  name: string;
  required: boolean;
  /** Why the gate is (not) required, for the report. */
  reason: string;
  command?: string;
  collect: string[];
}

/** Gates whose implementation is built into the verification engine. */
export const BUILTIN_GATES = ['diff_present', 'test_integrity', 'secrets_scan', 'requirements_coverage', 'independent_review'] as const;
export const COMMAND_GATES = ['typecheck', 'lint', 'build', 'unit_tests', 'integration_tests', 'e2e_tests', 'security_scan'] as const;

export function planGates(policy: ProjectPolicy, changedFiles: string[]): GatePlan[] {
  const plans: GatePlan[] = [];
  for (const [name, rule] of Object.entries(policy.quality) as [string, GateRule][]) {
    const mode = typeof rule === 'string' ? rule : rule.mode;
    const when = typeof rule === 'string' ? undefined : rule.when;
    const collect = typeof rule === 'string' ? [] : (rule.collect ?? []);
    const command = (policy.commands as Record<string, string | undefined>)[name];
    if (mode === 'off') {
      plans.push({ name, required: false, reason: 'disabled by policy', command, collect });
      continue;
    }
    if (mode === 'required') {
      plans.push({ name, required: true, reason: 'required by policy', command, collect });
      continue;
    }
    const patterns = when?.paths ?? [];
    const hit = changedFiles.find((f) => matchesAny(f, patterns));
    plans.push({
      name,
      required: Boolean(hit),
      reason: hit ? `conditional: ${hit} matches ${patterns.join(', ')}` : 'conditional: no matching changes',
      command,
      collect,
    });
  }
  return plans;
}

export function isHighRisk(policy: ProjectPolicy, files: string[]): string[] {
  return files.filter((f) => matchesAny(f, policy.paths.high_risk));
}

// ---------------------------------------------------------------------------
// Tool-use policy (enforced from the agent runtime's PreToolUse hook)
// ---------------------------------------------------------------------------
export type ToolDecision = { allow: true } | { allow: false; reason: string };

export interface ToolContext {
  role: AgentRole;
  worktree: string;
  policy: LoadedPolicy;
}

const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const;
const ALWAYS_ALLOWED = new Set(['StructuredOutput']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SECRET_READ = ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', '.npmrc', '.netrc'];

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // New file: resolve its existing parent to defeat symlinked directories.
    const parent = dirname(p);
    try {
      return join(realpathSync(parent), p.slice(parent.length + 1));
    } catch {
      return p;
    }
  }
}

/** Returns the path relative to the worktree, or null when it escapes it. */
export function confine(worktree: string, p: string): string | null {
  const root = realOrResolved(resolve(worktree));
  const abs = realOrResolved(isAbsolute(p) ? p : resolve(root, p));
  const rel = relative(root, abs);
  if (rel === '') return '.';
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

function splitShell(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function checkBash(command: string, mode: 'none' | 'readonly' | 'full', perms: Permissions): ToolDecision {
  if (mode === 'none') return { allow: false, reason: 'Bash is not available for this role' };
  for (const pattern of perms.bash.deny) {
    if (new RegExp(pattern, 'i').test(command)) return { allow: false, reason: `command matches deny rule /${pattern}/` };
  }
  if (mode === 'readonly') {
    if (/(^|[^0-9&])>{1,2}(?!&)/.test(command.replace(/2>&1|>\s*\/dev\/null/g, '')))
      return { allow: false, reason: 'output redirection is not allowed for read-only roles' };
    for (const raw of splitShell(command)) {
      // `git --no-pager log`, `git -C dir diff` are still read-only git subcommands.
      const seg = raw.replace(/^git\s+((--no-pager|-C\s+\S+|-c\s+\S+)\s+)+/, 'git ');
      const ok = perms.bash.readonly_allow.some((prefix) => seg === prefix || seg.startsWith(prefix + ' '));
      if (!ok) return { allow: false, reason: `"${seg.split(' ')[0]}" is not an allowed read-only command` };
    }
  }
  return { allow: true };
}

export function checkToolUse(ctx: ToolContext, toolName: string, input: Record<string, unknown>): ToolDecision {
  const { permissions, project } = ctx.policy;
  const role = permissions.roles[ctx.role];
  if (!role) return { allow: false, reason: `unknown role ${ctx.role}` };
  // Claude Code's channel for returning the --json-schema result; it has no side effects.
  if (ALWAYS_ALLOWED.has(toolName)) return { allow: true };
  if (permissions.forbidden_tools.includes(toolName) || toolName.startsWith('mcp__'))
    return { allow: false, reason: `${toolName} is forbidden for all agents` };
  if ((toolName === 'WebFetch' || toolName === 'WebSearch') && !project.agents.allow_web)
    return { allow: false, reason: 'web access disabled by policy' };
  if (!role.tools.includes(toolName)) return { allow: false, reason: `${toolName} is not allowed for ${ctx.role}` };

  if (toolName === 'Bash') return checkBash(String(input.command ?? ''), role.bash, permissions);

  for (const key of PATH_KEYS) {
    const raw = input[key];
    if (typeof raw !== 'string' || raw === '') continue;
    const rel = confine(ctx.worktree, raw);
    if (rel === null) return { allow: false, reason: `path ${raw} is outside the task worktree` };
    if (!WRITE_TOOLS.has(toolName)) {
      if (rel !== '.' && matchesAny(rel, SECRET_READ)) return { allow: false, reason: `reading ${rel} is forbidden (secrets)` };
      continue;
    }
    if (matchesAny(rel, project.paths.protected)) return { allow: false, reason: `${rel} is a protected path` };
    if (role.write === 'none') return { allow: false, reason: `${ctx.role} is read-only` };
    if (role.write === 'tests' && !matchesAny(rel, project.paths.tests))
      return { allow: false, reason: `${ctx.role} may only modify test files; ${rel} is not a test file` };
  }
  return { allow: true };
}
