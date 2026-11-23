import { hostname } from 'node:os';
import { bootstrap, redisConnection, startWorker } from '@devpilot/orchestrator';

const workerId = `${hostname()}-${process.pid}`;
const log = (l: string) => console.log(l);
const { store, orchestrator } = await bootstrap({ workerId, log });
// One subscription = one shared usage window, so default to a single task at a time.
const concurrency = Number(process.env.DEVPILOT_CONCURRENCY ?? 1);
const handle = await startWorker({ orchestrator, store, connection: redisConnection(), concurrency, log });
console.log(`worker ${workerId} up, concurrency=${concurrency}`);

const shutdown = async () => {
  orchestrator.stopHeartbeats();
  await handle.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
