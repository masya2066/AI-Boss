import type { Store } from '@devpilot/database';
import type { AgentRun, Task, TaskEvent } from '@devpilot/shared';

/**
 * Section 11 metrics: is DevPilot actually better, and at what cost?
 * Computed from durable facts only (task states, gate events, agent runs),
 * over top-level tasks; subtasks roll up into their parent.
 */
export interface Metrics {
  window: { projectId?: string; since?: string; until: string };
  tasks: { total: number; done: number; blocked: number; failed: number; cancelled: number; active: number; awaitingHuman: number };
  /** DONE without a single repair attempt (subtasks included). */
  firstPassSuccessRate: number | null;
  /** DONE without any human input (approvals, answers, resumes) / finished. */
  autonomousCompletionRate: number | null;
  escapedDefects: { ciFailuresAfterPr: number; reportedAfterDelivery: number; perAcceptedTask: number | null };
  /** Share of requirements of DONE tasks backed by passing tests. */
  requirementCoverage: number | null;
  /** Tasks that hit an incident (crash, step failure, usage limit, worker change) and still reached DONE. */
  recovery: { incidents: number; recovered: number; rate: number | null };
  costPerAcceptedTaskUsd: number | null;
  totalCostUsd: number;
  avgDurationMinutes: number | null;
  avgRepairAttempts: number | null;
  gateFailures: { gate: string; failures: number }[];
  recurringFailures: { fingerprint: string; gate?: string; summary: string; occurrences: number; tasks: number }[];
  costByRole: Record<string, number>;
  costByModel: Record<string, { runs: number; costUsd: number }>;
  deniedToolCalls: number;
  daily: { date: string; created: number; done: number; costUsd: number }[];
}

const ratio = (a: number, b: number) => (b > 0 ? Number((a / b).toFixed(4)) : null);
const round = (n: number) => Number(n.toFixed(4));

export async function computeMetrics(store: Store, o: { projectId?: string; since?: string } = {}): Promise<Metrics> {
  const all = await store.listTasks({ projectId: o.projectId });
  const byId = new Map(all.map((t) => [t.id, t]));
  const childrenOf = new Map<string, Task[]>();
  for (const t of all) if (t.parentId) (childrenOf.get(t.parentId) ?? childrenOf.set(t.parentId, []).get(t.parentId)!).push(t);
  const tree = (t: Task): Task[] => [t, ...(childrenOf.get(t.id) ?? []).flatMap(tree)];
  const top = all.filter((t) => !t.parentId && (!o.since || t.createdAt >= o.since));
  const ids = top.flatMap((t) => tree(t).map((x) => x.id));
  const [events, runs] = await Promise.all([store.listEventsForTasks(ids), store.listAgentRunsForTasks(ids)]);
  const evBy = new Map<string, TaskEvent[]>();
  for (const e of events) (evBy.get(e.taskId) ?? evBy.set(e.taskId, []).get(e.taskId)!).push(e);
  const runsBy = new Map<string, AgentRun[]>();
  for (const r of runs) (runsBy.get(r.taskId) ?? runsBy.set(r.taskId, []).get(r.taskId)!).push(r);

  const count = (s: Task['state'][]) => top.filter((t) => s.includes(t.state)).length;
  const done = top.filter((t) => t.state === 'DONE');
  const finished = top.filter((t) => ['DONE', 'BLOCKED', 'FAILED'].includes(t.state));
  const treeCost = (t: Task) => tree(t).reduce((s, x) => s + x.costUsd, 0);
  const treeRepairs = (t: Task) => tree(t).reduce((s, x) => s + x.repairAttempts, 0);
  const treeHuman = (t: Task) => tree(t).some((x) => x.humanInput.length > 0);
  const treeEvents = (t: Task) => tree(t).flatMap((x) => evBy.get(x.id) ?? []);

  const incident = (t: Task) => {
    const ev = treeEvents(t);
    const workers = new Set(ev.filter((e) => e.type === 'step_started').map((e) => String(e.data.worker)));
    return ev.some((e) => e.type === 'step_failed' || e.type === 'paused_usage_limit') || workers.size > 1 || tree(t).some((x) => (runsBy.get(x.id) ?? []).some((r) => r.status === 'interrupted' || r.error === 'superseded by resumed run'));
  };
  const incidents = finished.filter(incident);

  const reqs = done.flatMap((t) => t.requirements);
  const gateFail = new Map<string, number>();
  for (const e of events) if (e.type === 'gates_evaluated') for (const [g, v] of Object.entries((e.data.gates ?? {}) as Record<string, { status: string; required: boolean }>)) if (v.required && v.status === 'failed') gateFail.set(g, (gateFail.get(g) ?? 0) + 1);
  for (const e of events) if (e.type === 'review_recorded' && e.data.status === 'failed') gateFail.set('independent_review', (gateFail.get('independent_review') ?? 0) + 1);
  for (const e of events) if (e.type === 'ci_polled' && e.data.state === 'fail') gateFail.set('ci', (gateFail.get('ci') ?? 0) + 1);

  const fp = new Map<string, { gate?: string; summary: string; occurrences: number; tasks: Set<string> }>();
  for (const t of top) for (const x of tree(t)) for (const d of x.defects) {
    const f = fp.get(d.fingerprint) ?? { gate: d.gate, summary: d.summary, occurrences: 0, tasks: new Set<string>() };
    f.occurrences++;
    f.tasks.add(t.id);
    fp.set(d.fingerprint, f);
  }

  const costByRole: Record<string, number> = {};
  const costByModel: Record<string, { runs: number; costUsd: number }> = {};
  let denied = 0;
  for (const r of runs) {
    costByRole[r.role] = round((costByRole[r.role] ?? 0) + r.costUsd);
    const m = (costByModel[r.model ?? 'unknown'] ??= { runs: 0, costUsd: 0 });
    m.runs++;
    m.costUsd = round(m.costUsd + r.costUsd);
    denied += r.deniedToolCalls.length;
  }

  const dayMap = new Map<string, { created: number; done: number; costUsd: number }>();
  for (const t of top) {
    const d = t.createdAt.slice(0, 10);
    const row = dayMap.get(d) ?? { created: 0, done: 0, costUsd: 0 };
    row.created++;
    if (t.state === 'DONE') row.done++;
    row.costUsd = round(row.costUsd + treeCost(t));
    dayMap.set(d, row);
  }
  const totalCost = top.reduce((s, t) => s + treeCost(t), 0);
  const durations = done.filter((t) => t.startedAt).map((t) => (Date.parse(t.updatedAt) - Date.parse(t.startedAt!)) / 60000);

  return {
    window: { projectId: o.projectId, since: o.since, until: new Date().toISOString() },
    tasks: {
      total: top.length,
      done: done.length,
      blocked: count(['BLOCKED']),
      failed: count(['FAILED']),
      cancelled: count(['CANCELLED']),
      awaitingHuman: count(['AWAITING_APPROVAL']),
      active: top.length - count(['DONE', 'BLOCKED', 'FAILED', 'CANCELLED', 'AWAITING_APPROVAL']),
    },
    firstPassSuccessRate: ratio(done.filter((t) => treeRepairs(t) === 0).length, done.length),
    autonomousCompletionRate: ratio(done.filter((t) => !treeHuman(t)).length, finished.length),
    escapedDefects: {
      ciFailuresAfterPr: top.reduce((s, t) => s + treeEvents(t).filter((e) => e.type === 'ci_polled' && e.data.state === 'fail').length, 0),
      reportedAfterDelivery: top.reduce((s, t) => s + treeEvents(t).filter((e) => e.type === 'escaped_defect').length, 0),
      perAcceptedTask: ratio(top.reduce((s, t) => s + treeEvents(t).filter((e) => e.type === 'escaped_defect').length, 0), done.length),
    },
    requirementCoverage: ratio(reqs.filter((r) => r.status === 'covered' || r.status === 'verified').length, reqs.length),
    recovery: { incidents: incidents.length, recovered: incidents.filter((t) => t.state === 'DONE').length, rate: ratio(incidents.filter((t) => t.state === 'DONE').length, incidents.length) },
    costPerAcceptedTaskUsd: done.length ? round(totalCost / done.length) : null,
    totalCostUsd: round(totalCost),
    avgDurationMinutes: durations.length ? round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    avgRepairAttempts: done.length ? round(done.reduce((s, t) => s + treeRepairs(t), 0) / done.length) : null,
    gateFailures: [...gateFail].map(([gate, failures]) => ({ gate, failures })).sort((a, b) => b.failures - a.failures),
    recurringFailures: [...fp]
      .filter(([, f]) => f.occurrences >= 2)
      .map(([fingerprint, f]) => ({ fingerprint, gate: f.gate, summary: f.summary, occurrences: f.occurrences, tasks: f.tasks.size }))
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 20),
    costByRole,
    costByModel,
    deniedToolCalls: denied,
    daily: [...dayMap].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** Project spend since local midnight (all agent runs, any task). */
export async function spentToday(store: Store, projectId: string, now = new Date()): Promise<number> {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const tasks = await store.listTasks({ projectId });
  const runs = await store.listAgentRunsForTasks(tasks.map((t) => t.id));
  return round(runs.filter((r) => Date.parse(r.startedAt) >= midnight.getTime()).reduce((s, r) => s + r.costUsd, 0));
}
