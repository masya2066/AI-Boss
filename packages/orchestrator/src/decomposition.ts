import { DevPilotError, type Requirement, type Subtask } from '@devpilot/shared';

export interface PlanCheck {
  subtasks: Subtask[];
  /** Dependencies the system added because parallel parts would edit the same files. */
  serialized: { key: string; after: string; files: string[] }[];
}

/**
 * Deterministic validation of the architect's subtask graph. A plan that does not
 * cover every requirement, references unknown keys or has a cycle is rejected.
 * Independent subtasks that declare the same files are serialized (merge conflicts
 * are expensive; the integrator is the fallback, not the plan).
 */
export function validatePlan(raw: Omit<Subtask, 'taskId' | 'integratedCommit'>[], requirements: Requirement[], maxSubtasks: number): PlanCheck {
  const fail = (m: string): never => {
    throw new DevPilotError(`invalid subtask plan: ${m}`, 'BAD_PLAN');
  };
  if (raw.length > maxSubtasks) fail(`${raw.length} subtasks > max ${maxSubtasks}`);
  const keys = new Set<string>();
  for (const s of raw) {
    if (keys.has(s.key)) fail(`duplicate key ${s.key}`);
    keys.add(s.key);
  }
  const reqIds = new Set(requirements.map((r) => r.id));
  for (const s of raw) {
    for (const d of s.dependsOn) if (!keys.has(d)) fail(`${s.key} depends on unknown ${d}`);
    if (s.dependsOn.includes(s.key)) fail(`${s.key} depends on itself`);
    for (const r of s.requirementIds) if (!reqIds.has(r)) fail(`${s.key} references unknown requirement ${r}`);
    if (!s.requirementIds.length) fail(`${s.key} covers no requirement`);
  }
  const uncovered = [...reqIds].filter((r) => !raw.some((s) => s.requirementIds.includes(r)));
  if (uncovered.length) fail(`requirements not covered by any subtask: ${uncovered.join(', ')}`);

  const subtasks: Subtask[] = raw.map((s) => ({ ...s, dependsOn: [...new Set(s.dependsOn)] }));
  const byKey = new Map(subtasks.map((s) => [s.key, s]));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return byKey.get(from)!.dependsOn.some((d) => reaches(d, to, seen));
  };
  topoOrder(subtasks); // throws on cycle

  const serialized: PlanCheck['serialized'] = [];
  for (let i = 0; i < subtasks.length; i++) {
    for (let j = i + 1; j < subtasks.length; j++) {
      const a = subtasks[i]!;
      const b = subtasks[j]!;
      const shared = a.files.filter((f) => b.files.includes(f));
      if (!shared.length || reaches(a.key, b.key) || reaches(b.key, a.key)) continue;
      b.dependsOn.push(a.key);
      serialized.push({ key: b.key, after: a.key, files: shared });
    }
  }
  return { subtasks: topoOrder(subtasks), serialized };
}

export function topoOrder(subtasks: Subtask[]): Subtask[] {
  const indeg = new Map(subtasks.map((s) => [s.key, s.dependsOn.length]));
  const order: Subtask[] = [];
  const queue = subtasks.filter((s) => s.dependsOn.length === 0);
  while (queue.length) {
    const s = queue.shift()!;
    order.push(s);
    for (const t of subtasks) {
      if (!t.dependsOn.includes(s.key)) continue;
      indeg.set(t.key, indeg.get(t.key)! - 1);
      if (indeg.get(t.key) === 0) queue.push(t);
    }
  }
  if (order.length !== subtasks.length)
    throw new DevPilotError(`invalid subtask plan: dependency cycle among ${subtasks.filter((s) => !order.includes(s)).map((s) => s.key).join(', ')}`, 'BAD_PLAN');
  return order;
}
