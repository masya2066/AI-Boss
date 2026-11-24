import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Store } from '@devpilot/database';
import type { TaskState } from '@devpilot/shared';
import type { Orchestrator } from './orchestrator';
import { QUEUE_NAME, enqueueStep } from './queue';

const ACTIVE: TaskState[] = ['QUEUED', 'DISCOVERY', 'SPECIFICATION', 'IMPACT_ANALYSIS', 'DECOMPOSITION', 'EXECUTING_SUBTASKS', 'IMPLEMENTATION', 'VALIDATION', 'REVIEW', 'REPAIR', 'DELIVERY'];

export interface WorkerHandle {
  queue: Queue;
  worker: Worker;
  close(): Promise<void>;
}

/**
 * Stateless BullMQ worker: one job = one orchestrator step. All state is in the
 * store, so a crash loses at most the step in flight; the lease expires and any
 * worker picks the task up again.
 */
export async function startWorker(o: {
  orchestrator: Orchestrator;
  store: Store;
  connection: ConnectionOptions;
  concurrency?: number;
  /** Re-enqueue every active task on start (after a crash / full restart). */
  recover?: boolean;
  /** Limit recovery to these projects (default: all). */
  projectIds?: string[];
  queueName?: string;
  /** Delay before retrying a task another worker holds. */
  busyRetryMs?: number;
  log?: (l: string) => void;
}): Promise<WorkerHandle> {
  const log = o.log ?? (() => {});
  const queueName = o.queueName ?? QUEUE_NAME;
  const queue = new Queue(queueName, { connection: o.connection });
  // New subtasks and parents whose child finished are scheduled immediately.
  o.orchestrator.setTaskReadyHook(async (id) => {
    const t = await o.store.getTask(id);
    if (t) await enqueueStep(queue, id, t.version, 0, `ready${Date.now()}`);
  });
  const worker = new Worker(
    queueName,
    async (job) => {
      const { taskId } = job.data as { taskId: string };
      const out = await o.orchestrator.step(taskId);
      const t = await o.store.getTask(taskId);
      if (!t) return out;
      if (out === 'continue') await enqueueStep(queue, taskId, t.version);
      if (out === 'busy') await enqueueStep(queue, taskId, t.version, o.busyRetryMs ?? 30_000, `busy${Date.now()}`);
      if (out === 'paused' && t.pausedUntil) {
        const slack = t.waitReason === 'usage_limit' ? 30_000 : 0;
        await enqueueStep(queue, taskId, t.version, Math.max(0, Date.parse(t.pausedUntil) - Date.now()) + slack, `p${Date.parse(t.pausedUntil)}`);
      }
      return out;
    },
    { connection: o.connection, concurrency: o.concurrency ?? 1, lockDuration: 10 * 60_000 },
  );
  worker.on('failed', (job, err) => log(`job ${job?.id} failed: ${err.message}`));

  if (o.recover !== false) {
    const active = (await o.store.listTasks({ states: ACTIVE })).filter((t) => !o.projectIds || o.projectIds.includes(t.projectId));
    for (const t of active) await enqueueStep(queue, t.id, t.version, 0, `recover${Date.now()}`);
    log(`recovered ${active.length} active tasks`);
  }
  return {
    queue,
    worker,
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
