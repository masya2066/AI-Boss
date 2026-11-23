import {
  DevPilotError,
  TERMINAL_STATES,
  nowIso,
  type GateResult,
  type Task,
  type TaskState,
} from '@devpilot/shared';

/**
 * Deterministic state machine for a task.
 * The orchestrator may only move a task through `transition()`; every edge is
 * whitelisted here and the important ones are protected by guards that look at
 * verifiable facts (gate results bound to a commit), never at agent claims.
 */
const EDGES: Record<TaskState, TaskState[]> = {
  QUEUED: ['DISCOVERY'],
  DISCOVERY: ['SPECIFICATION'],
  SPECIFICATION: ['IMPACT_ANALYSIS', 'AWAITING_APPROVAL'],
  IMPACT_ANALYSIS: ['IMPLEMENTATION', 'AWAITING_APPROVAL'],
  IMPLEMENTATION: ['VALIDATION'],
  VALIDATION: ['REVIEW', 'REPAIR', 'DELIVERY'],
  REVIEW: ['DELIVERY', 'REPAIR'],
  REPAIR: ['VALIDATION', 'BLOCKED'],
  DELIVERY: ['DONE', 'AWAITING_APPROVAL', 'REPAIR'], // REPAIR: CI failed on the PR
  AWAITING_APPROVAL: [
    'SPECIFICATION',
    'IMPACT_ANALYSIS',
    'IMPLEMENTATION',
    'VALIDATION',
    'REPAIR',
    'DELIVERY',
  ],
  BLOCKED: ['REPAIR', 'VALIDATION', 'IMPLEMENTATION', 'SPECIFICATION'],
  DONE: [],
  FAILED: [],
  CANCELLED: [],
};

/** Any non-terminal state can be cancelled or failed. */
const UNIVERSAL_TARGETS: TaskState[] = ['CANCELLED', 'FAILED', 'BLOCKED'];

export interface GuardContext {
  /** Current HEAD of the task worktree, as read by git (not reported by an agent). */
  headCommit: string;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

export function requiredGates(task: Task): GateResult[] {
  return Object.values(task.gates).filter((g) => g.required);
}

/** Every required gate passed for exactly this commit. Stale passes do not count. */
export function allRequiredGatesPassed(
  task: Task,
  headCommit: string,
  opts: { exclude?: string[] } = {},
): GuardResult {
  const gates = requiredGates(task).filter((g) => !opts.exclude?.includes(g.name));
  if (gates.length === 0) return { ok: false, reason: 'no required gates were evaluated' };
  const bad = gates.filter((g) => g.status !== 'passed' || g.commit !== headCommit);
  if (bad.length > 0) {
    const list = bad
      .map((g) => `${g.name}=${g.status}${g.commit !== headCommit ? '(stale)' : ''}`)
      .join(', ');
    return { ok: false, reason: `required gates not passed at ${headCommit.slice(0, 8)}: ${list}` };
  }
  return { ok: true };
}

function guard(task: Task, to: TaskState, ctx: GuardContext): GuardResult {
  switch (to) {
    case 'IMPLEMENTATION':
      if (task.requirements.length === 0)
        return { ok: false, reason: 'cannot implement without requirements' };
      if (!task.worktreePath) return { ok: false, reason: 'no isolated worktree' };
      return { ok: true };
    case 'REVIEW':
      // Review is only meaningful on code that already passed the deterministic gates.
      return allRequiredGatesPassed(task, ctx.headCommit, { exclude: ['independent_review', 'ci'] });
    case 'DELIVERY':
      // CI runs on the PR, which is opened during DELIVERY; DONE requires it.
      return allRequiredGatesPassed(task, ctx.headCommit, { exclude: ['ci'] });
    case 'DONE': {
      const gates = allRequiredGatesPassed(task, ctx.headCommit);
      if (!gates.ok) return gates;
      if (!task.reportPath) return { ok: false, reason: 'delivery report missing' };
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}

export function canTransition(task: Task, to: TaskState, ctx: GuardContext): GuardResult {
  if (TERMINAL_STATES.includes(task.state))
    return { ok: false, reason: `task is terminal (${task.state})` };
  const allowed = EDGES[task.state].includes(to) || UNIVERSAL_TARGETS.includes(to);
  if (!allowed) return { ok: false, reason: `illegal transition ${task.state} -> ${to}` };
  if (to === 'AWAITING_APPROVAL' && !task.approval)
    return { ok: false, reason: 'AWAITING_APPROVAL requires an approval request' };
  return guard(task, to, ctx);
}

export interface TransitionResult {
  task: Task;
  event: { type: 'state_changed'; data: Record<string, unknown> };
}

/** Pure: returns the next task value. Throws on illegal/guarded transitions. */
export function transition(
  task: Task,
  to: TaskState,
  ctx: GuardContext,
  reason?: string,
): TransitionResult {
  const check = canTransition(task, to, ctx);
  if (!check.ok) throw new DevPilotError(check.reason, 'TRANSITION_REJECTED');
  const next: Task = {
    ...task,
    state: to,
    headCommit: ctx.headCommit || task.headCommit,
    updatedAt: nowIso(),
  };
  return {
    task: next,
    event: { type: 'state_changed', data: { from: task.state, to, reason: reason ?? null } },
  };
}

export const isTerminal = (s: TaskState) => TERMINAL_STATES.includes(s);
export const isWaiting = (s: TaskState) => s === 'AWAITING_APPROVAL' || s === 'BLOCKED';
export { EDGES };
