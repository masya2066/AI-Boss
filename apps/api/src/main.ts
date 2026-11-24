import { Queue } from 'bullmq';
import { LocalScheduler, QUEUE_NAME, bootstrap, enqueueStep, redisConnection } from '@devpilot/orchestrator';
import { TelegramBot, attachNotifier, notifierConfigFromEnv } from '@devpilot/notifier';
import { buildApi } from './app';

const log = (l: string) => console.log(l);
const { store, orchestrator } = await bootstrap({ workerId: `api-${process.pid}`, log });

// Server mode (REDIS_URL): steps go to the BullMQ queue, workers execute them.
// Embedded mode (no Redis): this process runs tasks itself — handy on a laptop.
let schedule: (taskId: string) => Promise<void>;
let mode: 'queue' | 'embedded';
if (process.env.REDIS_URL) {
  const queue = new Queue(QUEUE_NAME, { connection: redisConnection() });
  schedule = async (id) => {
    const t = await store.getTask(id);
    if (t) await enqueueStep(queue, id, t.version, 0, `api${Date.now()}`);
  };
  mode = 'queue';
} else {
  const local = new LocalScheduler(orchestrator, store, log);
  schedule = (id) => local.schedule(id);
  mode = 'embedded';
  // In embedded mode this process executes tasks, so it also sends the notifications.
  const n = notifierConfigFromEnv();
  if (n) attachNotifier(orchestrator, n, log);
  log(`embedded mode: recovered ${await local.recover()} active tasks`);
}

const tg = notifierConfigFromEnv()?.telegram;
if (tg && process.env.DEVPILOT_TELEGRAM_COMMANDS !== '0') new TelegramBot({ telegram: tg, orchestrator, schedule, log }).start();

const app = buildApi({ orchestrator, schedule, token: process.env.DEVPILOT_API_TOKEN, logger: true, mode });
const port = Number(process.env.PORT ?? 4317);
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
log(`DevPilot API (${mode}) on http://${process.env.HOST ?? '127.0.0.1'}:${port}/dashboard/`);
