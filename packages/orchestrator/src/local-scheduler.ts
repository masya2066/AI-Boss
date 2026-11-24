import type { Store } from '@devpilot/database';
import type { TaskState } from '@devpilot/shared';
import type { Orchestrator } from './orchestrator';

const ACTIVE: TaskState[] = ['QUEUED', 'DISCOVERY', 'SPECIFICATION', 'IMPACT_ANALYSIS', 'DECOMPOSITION', 'EXECUTING_SUBTASKS', 'IMPLEMENTATION', 'VALIDATION', 'REVIEW', 'REPAIR', 'DELIVERY'];

/**
 * Single-process scheduler (no Redis): runs tasks in the background of the API
 * process. Same orchestrator, same durable store — just no queue in between.
 */
export class LocalScheduler {
  private readonly running = new Map<string, Promise<void>>();
  private again = new Set<string>();
  constructor(
    private readonly orch: Orchestrator,
    private readonly store: Store,
    private readonly log: (l: string) => void = () => {},
  ) {}

  async schedule(taskId: string): Promise<void> {
    const t = await this.store.getTask(taskId);
    if (t?.parentId) return this.schedule(t.parentId); // the parent drives its subtasks in-process
    if (this.running.has(taskId)) {
      this.again.add(taskId);
      return;
    }
    const p = (async () => {
      do {
        this.again.delete(taskId);
        try {
          await this.orch.run(taskId, { waitOnPause: true });
        } catch (e) {
          this.log(`[${taskId}] run failed: ${(e as Error).message}`);
        }
      } while (this.again.has(taskId));
    })().finally(() => this.running.delete(taskId));
    this.running.set(taskId, p);
  }

  async recover() {
    const active = (await this.store.listTasks({ states: ACTIVE })).filter((t) => !t.parentId);
    for (const t of active) await this.schedule(t.id);
    return active.length;
  }

  /** For tests: wait until nothing is running. */
  async idle() {
    while (this.running.size) await Promise.all([...this.running.values()]);
  }
}
