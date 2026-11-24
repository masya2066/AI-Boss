import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DevPilotError, type TaskState } from '@devpilot/shared';
import type { Orchestrator } from '@devpilot/orchestrator';
import { buildContext } from '@devpilot/project-intelligence';
import { computeMetrics } from '@devpilot/metrics';

const DASHBOARD_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/public');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export interface ApiOptions {
  orchestrator: Orchestrator;
  /** Make a task run now (queue job in server mode, background run in embedded mode). */
  schedule: (taskId: string) => Promise<void>;
  token?: string;
  logger?: boolean;
  mode: 'queue' | 'embedded';
}

export function buildApi(o: ApiOptions): FastifyInstance {
  const orch = o.orchestrator;
  const store = orch.store;
  const app = Fastify({ logger: o.logger ?? false });

  // Dashboard + static files are public; the API needs the token (header, or ?token= for SSE).
  app.addHook('onRequest', async (req, reply) => {
    if (!o.token) return;
    const path = req.url.split('?')[0]!;
    if (path === '/' || path.startsWith('/dashboard') || path === '/health') return;
    const q = new URL(req.url, 'http://x').searchParams.get('token');
    if (req.headers.authorization !== `Bearer ${o.token}` && q !== o.token) return reply.code(401).send({ error: 'unauthorized' });
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'validation', issues: err.issues });
    if (err instanceof DevPilotError) {
      const code = err.code === 'NOT_FOUND' ? 404 : err.code === 'BAD_STATE' || err.code === 'TRANSITION_REJECTED' ? 409 : 400;
      return reply.code(code).send({ error: err.code, message: err.message });
    }
    reply.code(500).send({ error: 'internal', message: (err as Error).message });
  });

  // ---------------------------------------------------------------- dashboard
  const serve = (file: string, reply: any) => {
    const p = normalize(join(DASHBOARD_DIR, file));
    if (!p.startsWith(DASHBOARD_DIR) || !existsSync(p)) return reply.code(404).send('not found');
    // no-cache: after an update the browser revalidates instead of running a stale dashboard
    return reply.header('cache-control', 'no-cache').type(MIME[extname(p)] ?? 'application/octet-stream').send(readFileSync(p));
  };
  app.get('/', async (_req, reply) => reply.redirect('/dashboard/'));
  app.get('/dashboard/', async (_req, reply) => serve('index.html', reply));
  app.get('/dashboard/*', async (req, reply) => serve((req.params as { '*': string })['*'] || 'index.html', reply));

  app.get('/health', async () => ({ ok: true, mode: o.mode }));

  // ----------------------------------------------------------------- projects
  app.post('/projects', async (req) => {
    const b = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/), repoPath: z.string(), policyPath: z.string().optional(), defaultBranch: z.string().optional() }).parse(req.body);
    return orch.registerProject(b);
  });
  app.get('/projects', async () => store.listProjects());
  app.get('/projects/:id/index', async (req) => {
    const idx = await orch.projectIndex((req.params as { id: string }).id);
    return { commit: idx.commit, stats: idx.stats, packages: idx.packages, api: idx.api, pages: idx.pages, tables: idx.tables, integrations: idx.integrations, env: Object.keys(idx.env), ci: idx.ci };
  });
  app.get('/projects/:id/search', async (req) => {
    const q = z.object({ q: z.string().min(1) }).parse(req.query);
    return buildContext(await orch.projectIndex((req.params as { id: string }).id), { terms: [q.q] });
  });
  app.get('/projects/:id/knowledge', async (req) => (await orch.knowledge((req.params as { id: string }).id)) ?? { features: [] });

  // -------------------------------------------------------------------- tasks
  app.post('/tasks', async (req, reply) => {
    const b = z.object({ projectId: z.string(), prompt: z.string().min(5), title: z.string().optional() }).parse(req.body);
    const t = await orch.createTask(b);
    await o.schedule(t.id);
    return reply.code(201).send(t);
  });
  app.get('/tasks', async (req) => {
    const q = z.object({ projectId: z.string().optional(), state: z.string().optional(), all: z.string().optional() }).parse(req.query);
    const ts = await store.listTasks({ projectId: q.projectId, states: q.state ? (q.state.split(',') as TaskState[]) : undefined });
    return (q.all ? ts : ts.filter((t) => !t.parentId)).reverse();
  });
  app.get('/tasks/:id', async (req) => {
    const { id } = req.params as { id: string };
    const t = await store.getTask(id);
    if (!t) throw new DevPilotError('not found', 'NOT_FOUND');
    const children = await Promise.all((t.subtasks ?? []).filter((s) => s.taskId).map((s) => store.getTask(s.taskId!)));
    return { task: t, agentRuns: await store.listAgentRuns(id), children: children.filter(Boolean) };
  });
  app.get('/tasks/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    return store.listEvents(id, Number((req.query as { after?: string }).after ?? 0));
  });
  app.get('/tasks/:id/report', async (req, reply) => {
    const t = await store.getTask((req.params as { id: string }).id);
    if (!t?.reportPath || !existsSync(t.reportPath)) throw new DevPilotError('no report yet', 'NOT_FOUND');
    return reply.type('text/markdown; charset=utf-8').send(readFileSync(t.reportPath, 'utf8'));
  });
  app.post('/tasks/:id/approve', async (req) => {
    const b = z.object({ answer: z.string().min(1) }).parse(req.body);
    const t = await orch.approve((req.params as { id: string }).id, b.answer);
    await o.schedule(t.id);
    return t;
  });
  app.post('/tasks/:id/resume', async (req) => {
    const b = z.object({ note: z.string().optional(), extraRepairAttempts: z.number().int().nonnegative().optional() }).parse(req.body ?? {});
    const t = await orch.resume((req.params as { id: string }).id, b);
    await o.schedule(t.parentId ?? t.id);
    return t;
  });
  app.post('/tasks/:id/cancel', async (req) => orch.cancel((req.params as { id: string }).id, (req.body as { reason?: string } | undefined)?.reason));
  /** A defect found after delivery (in review, staging or production): the "escaped defects" metric. */
  app.post('/tasks/:id/escaped-defect', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ description: z.string().min(3), severity: z.enum(['blocker', 'major', 'minor']).default('major'), foundIn: z.string().default('production') }).parse(req.body);
    if (!(await store.getTask(id))) throw new DevPilotError('not found', 'NOT_FOUND');
    await store.appendEvent(id, 'escaped_defect', b);
    return reply.code(201).send({ ok: true });
  });
  app.get('/approvals', async () => (await store.listTasks({ states: ['AWAITING_APPROVAL'] })).map((t) => ({ id: t.id, title: t.title, parentId: t.parentId, approval: t.approval })));

  // ------------------------------------------------------------------ metrics
  app.get('/metrics', async (req) => {
    const q = z.object({ projectId: z.string().optional(), since: z.string().optional() }).parse(req.query);
    return computeMetrics(store, q);
  });

  // ------------------------------------------------------- live event stream
  // Live view: what is running right now (active root tasks + the ones finished in the last
  // 2 hours), their subtask graph, the agents at work and what each one is doing.
  app.get('/live', async () => {
    const all = await store.listTasks();
    const recent = Date.now() - 2 * 3600_000;
    const TERMINAL = ['DONE', 'FAILED', 'CANCELLED'];
    const roots = all
      .filter((t) => !t.parentId && (!TERMINAL.includes(t.state) || Date.parse(t.updatedAt) > recent))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 10);
    return {
      now: new Date().toISOString(),
      tasks: await Promise.all(
        roots.map(async (task) => {
          const children = all.filter((c) => c.parentId === task.id);
          const ids = [task.id, ...children.map((c) => c.id)];
          const runs = await store.listAgentRunsForTasks(ids);
          const events = await store.listEventsForTasks(ids, ['agent_activity', 'state_changed', 'subtask_integrated', 'gates_evaluated', 'review_recorded', 'stale_agent_killed']);
          const lastActivity: Record<string, unknown> = {};
          for (const e of events) if (e.type === 'agent_activity') lastActivity[e.taskId] = { ...e.data, ts: e.ts };
          return {
            task,
            children,
            running: runs.filter((r) => r.status === 'running'),
            agentRuns: runs.length,
            lastActivity,
            feed: events.slice(-60).reverse(),
          };
        }),
      ),
    };
  });

  app.get('/events/stream', (req, reply) => {
    let after = Number((req.query as { after?: string }).after ?? 0);
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    reply.raw.write(': connected\n\n');
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const e of await store.listRecentEvents(after, 200)) {
          after = e.id;
          reply.raw.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
        }
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
    req.raw.on('close', () => (clearInterval(timer), clearInterval(ping)));
  });

  return app;
}
