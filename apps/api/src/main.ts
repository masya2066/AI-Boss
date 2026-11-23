import Fastify from 'fastify';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { DevPilotError } from '@devpilot/shared';
import { QUEUE_NAME, bootstrap, enqueueStep, redisConnection } from '@devpilot/orchestrator';

const { store, orchestrator } = await bootstrap();
const queue = new Queue(QUEUE_NAME, { connection: redisConnection() });
const app = Fastify({ logger: true });
const token = process.env.DEVPILOT_API_TOKEN;

app.addHook('onRequest', async (req, reply) => {
  if (token && req.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({ error: 'unauthorized' });
});
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof z.ZodError) return reply.code(400).send({ error: 'validation', issues: err.issues });
  if (err instanceof DevPilotError) {
    const code = err.code === 'NOT_FOUND' ? 404 : err.code === 'BAD_STATE' || err.code === 'TRANSITION_REJECTED' ? 409 : 400;
    return reply.code(code).send({ error: err.code, message: err.message });
  }
  reply.code(500).send({ error: 'internal', message: (err as Error).message });
});

app.get('/health', async () => ({ ok: true }));

app.post('/projects', async (req) => {
  const b = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/), repoPath: z.string(), policyPath: z.string().optional(), defaultBranch: z.string().optional() }).parse(req.body);
  return orchestrator.registerProject(b);
});
app.get('/projects', async () => store.listProjects());

app.post('/tasks', async (req, reply) => {
  const b = z.object({ projectId: z.string(), prompt: z.string().min(5), title: z.string().optional() }).parse(req.body);
  const t = await orchestrator.createTask(b);
  await enqueueStep(queue, t.id, t.version);
  return reply.code(201).send(t);
});
app.get('/tasks', async (req) => {
  const q = z.object({ projectId: z.string().optional(), state: z.string().optional() }).parse(req.query);
  return store.listTasks({ projectId: q.projectId, states: q.state ? (q.state.split(',') as never) : undefined });
});
app.get('/tasks/:id', async (req) => {
  const { id } = req.params as { id: string };
  const t = await store.getTask(id);
  if (!t) throw new DevPilotError('not found', 'NOT_FOUND');
  return { task: t, agentRuns: await store.listAgentRuns(id) };
});
app.get('/tasks/:id/events', async (req) => {
  const { id } = req.params as { id: string };
  const after = Number((req.query as { after?: string }).after ?? 0);
  return store.listEvents(id, after);
});
app.post('/tasks/:id/approve', async (req) => {
  const { id } = req.params as { id: string };
  const b = z.object({ answer: z.string().min(1) }).parse(req.body);
  const t = await orchestrator.approve(id, b.answer);
  await enqueueStep(queue, t.id, t.version);
  return t;
});
app.post('/tasks/:id/resume', async (req) => {
  const { id } = req.params as { id: string };
  const b = z.object({ note: z.string().optional(), extraRepairAttempts: z.number().int().nonnegative().optional() }).parse(req.body ?? {});
  const t = await orchestrator.resume(id, b);
  await enqueueStep(queue, t.id, t.version);
  return t;
});
app.post('/tasks/:id/cancel', async (req) => {
  const { id } = req.params as { id: string };
  return orchestrator.cancel(id, (req.body as { reason?: string } | undefined)?.reason);
});

const port = Number(process.env.PORT ?? 4317);
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
