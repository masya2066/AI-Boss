import { Queue } from 'bullmq';
import IORedis from 'ioredis';

/** Override with DEVPILOT_QUEUE to run several isolated DevPilot instances on one Redis. */
export const QUEUE_NAME = process.env.DEVPILOT_QUEUE ?? 'devpilot-steps';

export function redisConnection(url = process.env.REDIS_URL ?? 'redis://localhost:6379') {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

/** One job = one orchestrator step. jobId dedupes concurrent enqueues of the same step. */
export async function enqueueStep(queue: Queue, taskId: string, version: number, delayMs = 0, suffix = '') {
  // Duplicate steps are harmless (lease + optimistic version), so recovery/retry jobs get a unique suffix.
  await queue.add('step', { taskId }, { jobId: `${taskId}-v${version}${suffix ? '-' + suffix : ''}`, delay: delayMs, removeOnComplete: 1000, removeOnFail: 5000, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
}
