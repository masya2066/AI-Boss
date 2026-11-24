import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { DevPilotError, nowIso, type AgentRun, type Project, type Task, type TaskEvent, type TaskState } from '@devpilot/shared';
import type { Store } from './store';

interface Snapshot {
  projects: Record<string, Project>;
  tasks: Record<string, Task>;
  leases: Record<string, { owner: string; expiresAt: number }>;
  events: TaskEvent[];
  agentRuns: Record<string, AgentRun>;
  knowledge?: Record<string, unknown>;
  seq: number;
}

/**
 * In-process store. With `filePath` it persists atomically to a JSON file, which
 * is enough for the single-user CLI mode and survives process restarts.
 * Production deployments use PgStore.
 */
export class MemoryStore implements Store {
  private s: Snapshot = { projects: {}, tasks: {}, leases: {}, events: [], agentRuns: {}, seq: 0 };
  constructor(private readonly filePath?: string) {}

  async init() {
    if (this.filePath && existsSync(this.filePath)) {
      this.s = JSON.parse(readFileSync(this.filePath, 'utf8')) as Snapshot;
    }
  }
  async close() {
    // Every mutation is already on disk. Never write here: a read-only process (e.g. `status`
    // while a task runs elsewhere) would overwrite newer state with its stale snapshot.
    this.releaseLock();
  }
  private locked = false;
  /** One writing process per state file (use PostgreSQL for several workers). */
  private lock() {
    if (this.locked || !this.filePath) return;
    const f = `${this.filePath}.lock`;
    if (existsSync(f)) {
      const pid = Number(readFileSync(f, 'utf8'));
      let alive = false;
      try {
        if (pid && pid !== process.pid) {
          process.kill(pid, 0);
          alive = true;
        }
      } catch {
        /* dead process: stale lock */
      }
      if (alive)
        throw new DevPilotError(
          `state file ${this.filePath} is being written by another DevPilot process (pid ${pid}); use that process (its dashboard/API) or PostgreSQL for several processes`,
          'STORE_BUSY',
        );
    }
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, String(process.pid));
    this.locked = true;
    process.once('exit', () => this.releaseLock());
  }
  private releaseLock() {
    if (!this.locked || !this.filePath) return;
    try {
      if (Number(readFileSync(`${this.filePath}.lock`, 'utf8')) === process.pid) rmSync(`${this.filePath}.lock`, { force: true });
    } catch {
      /* already gone */
    }
    this.locked = false;
  }
  private flush() {
    if (!this.filePath) return;
    this.lock();
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.s)); // compact: rewritten on every event
    renameSync(tmp, this.filePath);
  }
  private clone<T>(v: T): T {
    return structuredClone(v);
  }

  async upsertProject(p: Project) {
    this.s.projects[p.id] = this.clone(p);
    this.flush();
  }
  async getProject(id: string) {
    const p = this.s.projects[id];
    return p && this.clone(p);
  }
  async listProjects() {
    return Object.values(this.s.projects).map((p) => this.clone(p));
  }

  async createTask(t: Task) {
    if (this.s.tasks[t.id]) throw new DevPilotError(`task ${t.id} exists`, 'DUPLICATE');
    this.s.tasks[t.id] = this.clone(t);
    this.flush();
  }
  async getTask(id: string) {
    const t = this.s.tasks[id];
    return t && this.clone(t);
  }
  async listTasks(filter: { projectId?: string; states?: TaskState[] } = {}) {
    return Object.values(this.s.tasks)
      .filter((t) => !filter.projectId || t.projectId === filter.projectId)
      .filter((t) => !filter.states || filter.states.includes(t.state))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((t) => this.clone(t));
  }
  async saveTask(t: Task, expectedVersion: number) {
    const cur = this.s.tasks[t.id];
    if (!cur) throw new DevPilotError(`task ${t.id} not found`, 'NOT_FOUND');
    if (cur.version !== expectedVersion)
      throw new DevPilotError(`version conflict on ${t.id}: ${cur.version} != ${expectedVersion}`, 'VERSION_CONFLICT');
    const next = { ...this.clone(t), version: expectedVersion + 1, updatedAt: nowIso() };
    this.s.tasks[t.id] = next;
    this.flush();
    return this.clone(next);
  }

  async acquireLease(taskId: string, owner: string, ttlMs: number) {
    const l = this.s.leases[taskId];
    const now = Date.now();
    if (l && l.owner !== owner && l.expiresAt > now) return false;
    this.s.leases[taskId] = { owner, expiresAt: now + ttlMs };
    this.flush();
    return true;
  }
  async releaseLease(taskId: string, owner: string) {
    if (this.s.leases[taskId]?.owner === owner) delete this.s.leases[taskId];
    this.flush();
  }

  async appendEvent(taskId: string, type: string, data: Record<string, unknown> = {}) {
    this.s.events.push({ id: ++this.s.seq, taskId, ts: nowIso(), type, data: this.clone(data) });
    this.flush();
  }
  async listEvents(taskId: string, afterId = 0) {
    return this.s.events.filter((e) => e.taskId === taskId && e.id > afterId).map((e) => this.clone(e));
  }

  async listRecentEvents(afterId: number, limit = 500) {
    return this.s.events.filter((e) => e.id > afterId).slice(0, limit).map((e) => this.clone(e));
  }
  async listEventsForTasks(taskIds: string[], types?: string[]) {
    const ids = new Set(taskIds);
    return this.s.events.filter((e) => ids.has(e.taskId) && (!types || types.includes(e.type))).map((e) => this.clone(e));
  }
  async listAgentRunsForTasks(taskIds: string[]) {
    const ids = new Set(taskIds);
    return Object.values(this.s.agentRuns).filter((r) => ids.has(r.taskId)).map((r) => this.clone(r));
  }

  async saveAgentRun(r: AgentRun) {
    this.s.agentRuns[r.id] = this.clone(r);
    this.flush();
  }
  async listAgentRuns(taskId: string) {
    return Object.values(this.s.agentRuns)
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((r) => this.clone(r));
  }

  async getKnowledge<T = unknown>(projectId: string) {
    const k = this.s.knowledge?.[projectId];
    return k === undefined ? undefined : (this.clone(k) as T);
  }
  async saveKnowledge(projectId: string, doc: unknown) {
    (this.s.knowledge ??= {})[projectId] = this.clone(doc);
    this.flush();
  }
}
