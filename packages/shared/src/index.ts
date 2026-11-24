// Core domain types shared by every DevPilot package.
// Rule of the system: agents never write these statuses directly.
// Gate/requirement statuses are produced only by the verification engine,
// task state only by the task engine.

export const TASK_STATES = [
  'QUEUED',
  'DISCOVERY',
  'SPECIFICATION',
  'IMPACT_ANALYSIS',
  /** Large task: validate the subtask graph and set up integration. */
  'DECOMPOSITION',
  /** Parent waits for / integrates subtasks running in their own worktrees. */
  'EXECUTING_SUBTASKS',
  'IMPLEMENTATION',
  'VALIDATION',
  'REVIEW',
  'REPAIR',
  'DELIVERY',
  'DONE',
  'AWAITING_APPROVAL',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: readonly TaskState[] = ['DONE', 'FAILED', 'CANCELLED'];
/** States in which the orchestrator waits for a human and does nothing on its own. */
export const WAITING_STATES: readonly TaskState[] = ['AWAITING_APPROVAL', 'BLOCKED'];

export type AgentRole = 'researcher' | 'architect' | 'developer' | 'qa' | 'reviewer' | 'fixer' | 'integrator';

export type GateStatus =
  | 'pending'
  | 'passed'
  | 'failed'
  /** Required, but could not be executed (no command, no environment, infra error). */
  | 'not_verified'
  /** Not required for this change according to policy rules. */
  | 'skipped';

export interface GateResult {
  name: string;
  status: GateStatus;
  required: boolean;
  /** Commit the gate was evaluated against. A pass is only valid for this exact commit. */
  commit: string;
  command?: string;
  exitCode?: number | null;
  durationMs?: number;
  /** Tail of combined output, kept small for the DB; full log goes to the artifacts dir. */
  outputTail?: string;
  logPath?: string;
  /** Evidence collected after the gate (reports, screenshots, traces). */
  artifacts?: string[];
  reason?: string;
  ranAt: string;
}

export type RequirementStatus = 'pending' | 'implemented' | 'covered' | 'verified' | 'failed';

export interface Requirement {
  id: string;
  description: string;
  acceptanceCriteria: string[];
  status: RequirementStatus;
  /** Test files that QA mapped to this requirement. */
  tests: string[];
}

export type DefectSource = 'gate' | 'review';
export type Severity = 'blocker' | 'major' | 'minor' | 'info';

export interface Defect {
  id: string;
  source: DefectSource;
  gate?: string;
  severity: Severity;
  /** Normalised failure signature, used to detect "same error again". */
  fingerprint: string;
  summary: string;
  details: string;
  file?: string;
  line?: number;
  requirementId?: string;
  foundInAttempt: number;
  resolved: boolean;
}

export type ApprovalKind = 'ambiguity' | 'spec' | 'high_risk' | 'before_pr';

export interface Approval {
  kind: ApprovalKind;
  reason: string;
  questions: string[];
  /** State the task returns to once approved. */
  resumeState: TaskState;
  requestedAt: string;
  answer?: string;
  answeredAt?: string;
}

export interface DiscoveryNotes {
  summary: string;
  relevantFiles: string[];
  existingPatterns: string[];
  risks: string[];
  /** Code-level terms (identifiers, English domain words) for deterministic search. */
  searchTerms: string[];
  /** Deterministic context built from the index around the task (rendered). */
  context?: string;
  contextFiles?: string[];
}

export interface ImpactAnalysis {
  summary: string;
  filesToChange: string[];
  /** Deterministically expanded via the import graph, not by the model. */
  dependentFiles: string[];
  /** Files sharing tables with the changed code (other consumers of the same entities). */
  relatedData?: string[];
  affectedTests: string[];
  modules: string[];
  risks: string[];
  plan: string[];
  touchesDatabase: boolean;
  touchesAuth: boolean;
  touchesPublicApi: boolean;
}

export interface Subtask {
  key: string;
  title: string;
  description: string;
  requirementIds: string[];
  /** Files the architect expects this part to change (used to detect overlap). */
  files: string[];
  dependsOn: string[];
  taskId?: string;
  /** Commit on the parent's integration branch after merging this subtask. */
  integratedCommit?: string;
  conflicts?: string[];
}

export interface Task {
  id: string;
  projectId: string;
  /** Set on subtasks: the parent task that integrates this one. */
  parentId?: string;
  subtaskKey?: string;
  /** How this task is executed (fixed at creation from execution.mode; subtasks are always pipeline). */
  mode?: 'solo' | 'pipeline';
  /** Commit to branch from (subtasks start from the parent's integration head). */
  baseRef?: string;
  /** Set on a decomposed parent: the validated subtask graph. */
  subtasks?: Subtask[];
  title: string;
  prompt: string;
  state: TaskState;
  /** Optimistic-lock version, incremented on every persisted change. */
  version: number;
  baseCommit?: string;
  branch?: string;
  worktreePath?: string;
  headCommit?: string;
  requirements: Requirement[];
  discovery?: DiscoveryNotes;
  impact?: ImpactAnalysis;
  gates: Record<string, GateResult>;
  defects: Defect[];
  repairAttempts: number;
  costUsd: number;
  approval?: Approval;
  /** Approvals already granted by a human (so we don't ask twice). */
  approvalsGranted: ApprovalKind[];
  /** Answers / notes from the human, fed into later agent prompts. */
  humanInput: { kind: string; text: string; at: string }[];
  assumptions: string[];
  /** Sub-step checkpoints inside a state, e.g. developer done at <commit>. */
  checkpoints: Record<string, string>;
  /** Open defect count + fingerprints after each repair attempt (stop rules). */
  repairHistory: { attempt: number; openDefects: number; fingerprints: string[] }[];
  /** Granted by a human when resuming a BLOCKED task. */
  extraRepairAttempts: number;
  /** Repair attempt number at the last human resume; stop rules only look after it. */
  resumedAtAttempt: number;
  /** Consecutive agent/infra failures per state (transient retry budget). */
  stepFailures: Record<string, number>;
  /** Subscription usage limit hit: no step runs before this instant (ISO). State is kept. */
  pausedUntil?: string;
  /** Why the task is paused: subscription usage limit or waiting for CI. */
  waitReason?: 'usage_limit' | 'ci' | 'subtasks' | 'budget';
  /** Deterministic complexity estimate (after impact analysis), drives model routing. */
  complexity?: { score: number; tier?: string; factors: Record<string, number> };
  /** Why the task is BLOCKED / FAILED. */
  stopReason?: string;
  prUrl?: string;
  reportPath?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  /**
   * Time actually spent working on this task (sum of its steps). Waiting for a human,
   * a usage-limit window, CI, subtasks, or a crashed process does not count.
   */
  activeMs?: number;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

export interface AgentRun {
  id: string;
  taskId: string;
  role: AgentRole;
  state: TaskState;
  sessionId?: string;
  model?: string;
  /** interrupted: stopped by a usage limit; its session is resumed later. */
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  subtype?: string;
  costUsd: number;
  numTurns: number;
  toolCalls: number;
  deniedToolCalls: { tool: string; reason: string }[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface Project {
  id: string;
  repoPath: string;
  /** Path to the project's devpilot policy YAML. */
  policyPath?: string;
  defaultBranch: string;
  createdAt: string;
}

export const nowIso = (): string => new Date().toISOString();

export function newId(prefix: string): string {
  const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
  const ts = Date.now().toString(36).toUpperCase();
  return `${prefix}-${ts}${rnd}`;
}

export function tail(text: string, maxChars = 4000): string {
  return text.length <= maxChars ? text : '…' + text.slice(text.length - maxChars);
}

export class DevPilotError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DevPilotError';
  }
}
