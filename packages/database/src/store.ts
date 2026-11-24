import type { AgentRun, Project, Task, TaskEvent, TaskState } from '@devpilot/shared';

export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;

  upsertProject(p: Project): Promise<void>;
  getProject(id: string): Promise<Project | undefined>;
  listProjects(): Promise<Project[]>;

  createTask(t: Task): Promise<void>;
  getTask(id: string): Promise<Task | undefined>;
  listTasks(filter?: { projectId?: string; states?: TaskState[] }): Promise<Task[]>;
  /**
   * Optimistic-locked write. Fails with VERSION_CONFLICT if someone else
   * changed the task since `expectedVersion`. Returns the stored task (version+1).
   */
  saveTask(t: Task, expectedVersion: number): Promise<Task>;

  /** Exclusive lease so that only one worker drives a task at a time. */
  acquireLease(taskId: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseLease(taskId: string, owner: string): Promise<void>;

  appendEvent(taskId: string, type: string, data?: Record<string, unknown>): Promise<void>;
  listEvents(taskId: string, afterId?: number): Promise<TaskEvent[]>;
  /** Global feed (all tasks) after an event id — for live dashboards / notifiers. */
  listRecentEvents(afterId: number, limit?: number): Promise<TaskEvent[]>;
  listEventsForTasks(taskIds: string[], types?: string[]): Promise<TaskEvent[]>;

  saveAgentRun(r: AgentRun): Promise<void>;
  listAgentRuns(taskId: string): Promise<AgentRun[]>;
  listAgentRunsForTasks(taskIds: string[]): Promise<AgentRun[]>;

  /** Project knowledge document (opaque JSON owned by project-intelligence). */
  getKnowledge<T = unknown>(projectId: string): Promise<T | undefined>;
  saveKnowledge(projectId: string, doc: unknown): Promise<void>;
}
