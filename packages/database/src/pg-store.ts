import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevPilotError, nowIso, type AgentRun, type Project, type Task, type TaskEvent, type TaskState } from '@devpilot/shared';
import type { Store } from './store';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export class PgStore implements Store {
  private pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  async init() {
    await this.migrate();
  }
  async close() {
    await this.pool.end();
  }

  async migrate() {
    const c = await this.pool.connect();
    try {
      await c.query('SELECT pg_advisory_lock(424242)');
      await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      const done = new Set((await c.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
        if (done.has(f)) continue;
        await c.query('BEGIN');
        await c.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
      }
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      await c.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
      c.release();
    }
  }

  async upsertProject(p: Project) {
    await this.pool.query(
      `INSERT INTO projects(id, repo_path, policy_path, default_branch, created_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET repo_path=EXCLUDED.repo_path, policy_path=EXCLUDED.policy_path, default_branch=EXCLUDED.default_branch`,
      [p.id, p.repoPath, p.policyPath ?? null, p.defaultBranch, p.createdAt],
    );
  }
  private rowToProject(r: any): Project {
    return {
      id: r.id,
      repoPath: r.repo_path,
      policyPath: r.policy_path ?? undefined,
      defaultBranch: r.default_branch,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }
  async getProject(id: string) {
    const r = await this.pool.query('SELECT * FROM projects WHERE id=$1', [id]);
    return r.rows[0] ? this.rowToProject(r.rows[0]) : undefined;
  }
  async listProjects() {
    const r = await this.pool.query('SELECT * FROM projects ORDER BY created_at');
    return r.rows.map((x) => this.rowToProject(x));
  }

  async createTask(t: Task) {
    await this.pool.query(
      'INSERT INTO tasks(id, project_id, state, version, doc, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [t.id, t.projectId, t.state, t.version, t, t.createdAt, t.updatedAt],
    );
  }
  async getTask(id: string) {
    const r = await this.pool.query<{ doc: Task }>('SELECT doc FROM tasks WHERE id=$1', [id]);
    return r.rows[0]?.doc;
  }
  async listTasks(filter: { projectId?: string; states?: TaskState[] } = {}) {
    const r = await this.pool.query<{ doc: Task }>(
      `SELECT doc FROM tasks WHERE ($1::text IS NULL OR project_id=$1) AND ($2::text[] IS NULL OR state = ANY($2)) ORDER BY created_at`,
      [filter.projectId ?? null, filter.states ?? null],
    );
    return r.rows.map((x) => x.doc);
  }
  async saveTask(t: Task, expectedVersion: number) {
    const next: Task = { ...t, version: expectedVersion + 1, updatedAt: nowIso() };
    const r = await this.pool.query(
      'UPDATE tasks SET doc=$1, state=$2, version=$3, updated_at=now() WHERE id=$4 AND version=$5',
      [next, next.state, next.version, t.id, expectedVersion],
    );
    if (r.rowCount !== 1) throw new DevPilotError(`version conflict on ${t.id}`, 'VERSION_CONFLICT');
    return next;
  }

  async acquireLease(taskId: string, owner: string, ttlMs: number) {
    const r = await this.pool.query(
      `UPDATE tasks SET lease_owner=$2, lease_expires_at=now() + ($3 || ' milliseconds')::interval
       WHERE id=$1 AND (lease_owner IS NULL OR lease_owner=$2 OR lease_expires_at < now())`,
      [taskId, owner, String(ttlMs)],
    );
    return r.rowCount === 1;
  }
  async releaseLease(taskId: string, owner: string) {
    await this.pool.query('UPDATE tasks SET lease_owner=NULL, lease_expires_at=NULL WHERE id=$1 AND lease_owner=$2', [taskId, owner]);
  }

  async appendEvent(taskId: string, type: string, data: Record<string, unknown> = {}) {
    await this.pool.query('INSERT INTO task_events(task_id, type, data) VALUES ($1,$2,$3)', [taskId, type, data]);
  }
  async listEvents(taskId: string, afterId = 0) {
    const r = await this.pool.query('SELECT * FROM task_events WHERE task_id=$1 AND id>$2 ORDER BY id', [taskId, afterId]);
    return r.rows.map(
      (x): TaskEvent => ({ id: Number(x.id), taskId: x.task_id, ts: new Date(x.ts).toISOString(), type: x.type, data: x.data }),
    );
  }

  private rowToEvent = (x: any): TaskEvent => ({ id: Number(x.id), taskId: x.task_id, ts: new Date(x.ts).toISOString(), type: x.type, data: x.data });
  async listRecentEvents(afterId: number, limit = 500) {
    const r = await this.pool.query('SELECT * FROM task_events WHERE id>$1 ORDER BY id LIMIT $2', [afterId, limit]);
    return r.rows.map(this.rowToEvent);
  }
  async listEventsForTasks(taskIds: string[], types?: string[]) {
    const r = await this.pool.query('SELECT * FROM task_events WHERE task_id = ANY($1) AND ($2::text[] IS NULL OR type = ANY($2)) ORDER BY id', [taskIds, types ?? null]);
    return r.rows.map(this.rowToEvent);
  }
  async listAgentRunsForTasks(taskIds: string[]) {
    const r = await this.pool.query<{ doc: AgentRun }>('SELECT doc FROM agent_runs WHERE task_id = ANY($1) ORDER BY started_at', [taskIds]);
    return r.rows.map((x) => x.doc);
  }

  async saveAgentRun(run: AgentRun) {
    await this.pool.query(
      `INSERT INTO agent_runs(id, task_id, role, status, session_id, doc, started_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, session_id=EXCLUDED.session_id, doc=EXCLUDED.doc`,
      [run.id, run.taskId, run.role, run.status, run.sessionId ?? null, run, run.startedAt],
    );
  }
  async listAgentRuns(taskId: string) {
    const r = await this.pool.query<{ doc: AgentRun }>('SELECT doc FROM agent_runs WHERE task_id=$1 ORDER BY started_at', [taskId]);
    return r.rows.map((x) => x.doc);
  }

  async getKnowledge<T = unknown>(projectId: string) {
    const r = await this.pool.query<{ doc: T }>('SELECT doc FROM project_knowledge WHERE project_id=$1', [projectId]);
    return r.rows[0]?.doc;
  }
  async saveKnowledge(projectId: string, doc: unknown) {
    await this.pool.query(
      `INSERT INTO project_knowledge(project_id, doc, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (project_id) DO UPDATE SET doc=EXCLUDED.doc, updated_at=now()`,
      [projectId, doc],
    );
  }
}
