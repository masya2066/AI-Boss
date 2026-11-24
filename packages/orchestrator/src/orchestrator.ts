import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { z } from 'zod';
import {
  DevPilotError,
  newId,
  nowIso,
  type AgentRole,
  type AgentRun,
  type Approval,
  type Project,
  type Subtask,
  type Task,
  type TaskState,
} from '@devpilot/shared';
import type { Store } from '@devpilot/database';
import { isTerminal, isWaiting, transition } from '@devpilot/task-engine';
import { loadPolicy, isHighRisk, DEFAULT_POLICIES_DIR, type LoadedPolicy } from '@devpilot/policy-engine';
import { GitManager, abortMerge, concludeMerge, filesWithConflictMarkers, mergeBranch, changedFiles, commitAll, createPullRequest, diff, failedCheckLog, findPullRequest, git, hasRemote, head, isClean, prChecks, push, updatePullRequestBody } from '@devpilot/git-manager';
import { DockerExecutor, LocalExecutor, type Executor } from '@devpilot/sandbox-manager';
import { fingerprint, recordReview, verify } from '@devpilot/verification-engine';
import {
  affectedTests,
  buildContext,
  buildIndex,
  consumersOfChange,
  dataNeighbours,
  dependents,
  featureMemory,
  formatContext,
  parseHunks,
  recordFeature,
  relevantKnowledge,
  summarize,
  type ProjectIndex,
  type ProjectKnowledge,
} from '@devpilot/project-intelligence';
import {
  DeveloperOutput,
  DiscoveryOutput,
  FixerOutput,
  ImpactOutput,
  IntegratorOutput,
  QaOutput,
  ReviewOutput,
  SpecOutput,
  type AgentRunner,
} from '@devpilot/agent-runtime';
import * as P from './prompts';
import { renderReport } from './report';
import { spentToday } from '@devpilot/metrics';
import { topoOrder, validatePlan } from './decomposition';

export interface OrchestratorDeps {
  store: Store;
  runner: AgentRunner;
  /** Root for worktrees, artifacts and reports. */
  dataDir: string;
  policiesDir?: string;
  workerId?: string;
  executorFactory?: (policy: LoadedPolicy) => Executor;
  log?: (line: string) => void;
  /** Lease TTL; renewed by a heartbeat while a step runs, so a crashed worker frees the task quickly. */
  leaseMs?: number;
  /** Called when a task should be scheduled now (new subtask, or a parent whose child finished). */
  onTaskReady?: (taskId: string) => Promise<void>;
}

export interface OrchestratorEvent {
  taskId: string;
  type: string;
  data: Record<string, unknown>;
  ts: string;
}

export type StepOutcome = 'continue' | 'waiting' | 'terminal' | 'busy' | 'paused';

interface ProjectCtx {
  project: Project;
  policy: LoadedPolicy;
  git: GitManager;
  executor: Executor;
}

/** Result of a state handler: what to change and where to go next. */
interface Step {
  patch?: Partial<Task>;
  to?: TaskState;
  reason?: string;
  /** Stay in the current state and run this step again not before this time (e.g. CI polling). */
  pause?: { until: number; reason: 'ci' | 'usage_limit' | 'subtasks' };
}

class AgentFailure extends Error {}
/** Subscription usage limit: not a failure of the task, just "come back later". */
class RateLimited extends Error {
  constructor(readonly until: number) {
    super(`usage limit until ${new Date(until).toISOString()}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_STEP_FAILURES = 3;

/**
 * The deterministic driver. One call to `step()` performs exactly one unit of
 * work for the task's current state, persists the result and returns. The task
 * can be resumed from the DB by any worker after a crash.
 */
export class Orchestrator {
  private readonly workerId: string;
  private readonly log: (l: string) => void;
  private readonly leaseMs: number;
  private readonly heartbeats = new Set<NodeJS.Timeout>();

  private readonly d: OrchestratorDeps;
  private readonly listeners = new Set<(e: OrchestratorEvent) => void>();

  constructor(deps: OrchestratorDeps) {
    // Every event written by this orchestrator is also published to in-process listeners
    // (notifier, live UI). Listener failures never affect task execution.
    const store = deps.store;
    const emit = (e: OrchestratorEvent) => {
      for (const l of this.listeners) {
        try {
          l(e);
        } catch {
          /* ignore */
        }
      }
    };
    this.d = {
      ...deps,
      store: new Proxy(store, {
        get(target, prop, recv) {
          if (prop === 'appendEvent')
            return async (taskId: string, type: string, data: Record<string, unknown> = {}) => {
              await target.appendEvent(taskId, type, data);
              emit({ taskId, type, data, ts: nowIso() });
            };
          const v = Reflect.get(target, prop, recv);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
    };
    this.workerId = deps.workerId ?? `worker-${process.pid}`;
    this.log = deps.log ?? (() => {});
    this.leaseMs = deps.leaseMs ?? 120_000;
  }

  /** Subscribe to every event this orchestrator writes. Returns an unsubscribe function. */
  on(listener: (e: OrchestratorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get store(): Store {
    return this.d.store;
  }

  /** Worker mode: how to schedule a task right away (set by startWorker). */
  setTaskReadyHook(fn: (taskId: string) => Promise<void>) {
    this.d.onTaskReady = fn;
  }

  /** Stop renewing leases (graceful shutdown, or simulating a crash in tests). */
  stopHeartbeats() {
    for (const h of this.heartbeats) clearInterval(h);
    this.heartbeats.clear();
  }

  // ------------------------------------------------------------------ API --
  async registerProject(p: { id: string; repoPath: string; policyPath?: string; defaultBranch?: string }): Promise<Project> {
    const repoPath = resolve(p.repoPath);
    if (!existsSync(join(repoPath, '.git'))) throw new DevPilotError(`${repoPath} is not a git repository`, 'BAD_PROJECT');
    const policyPath = p.policyPath ? resolve(p.policyPath) : existsSync(join(repoPath, 'devpilot.yaml')) ? join(repoPath, 'devpilot.yaml') : undefined;
    const policy = loadPolicy(policyPath, this.d.policiesDir);
    const project: Project = {
      id: p.id,
      repoPath,
      policyPath,
      defaultBranch: p.defaultBranch ?? policy.project.project.default_branch,
      createdAt: nowIso(),
    };
    await this.d.store.upsertProject(project);
    return project;
  }

  async createTask(i: { projectId: string; prompt: string; title?: string }): Promise<Task> {
    const project = await this.d.store.getProject(i.projectId);
    if (!project) throw new DevPilotError(`unknown project ${i.projectId}`, 'NOT_FOUND');
    const t: Task = {
      id: newId('TASK'),
      projectId: i.projectId,
      title: i.title ?? i.prompt.split('\n')[0]!.slice(0, 80),
      prompt: i.prompt,
      state: 'QUEUED',
      version: 0,
      requirements: [],
      gates: {},
      defects: [],
      repairAttempts: 0,
      costUsd: 0,
      approvalsGranted: [],
      humanInput: [],
      assumptions: [],
      checkpoints: {},
      repairHistory: [],
      extraRepairAttempts: 0,
      resumedAtAttempt: 0,
      stepFailures: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.d.store.createTask(t);
    await this.d.store.appendEvent(t.id, 'task_created', { prompt: i.prompt });
    return t;
  }

  /** Index of the project's checkout (outside any task). Unchanged files come from the cache. */
  async projectIndex(projectId: string): Promise<ProjectIndex> {
    const ctx = await this.ctx(projectId);
    return buildIndex(ctx.project.repoPath, { testGlobs: ctx.policy.project.paths.tests, cacheDir: join(this.d.dataDir, 'index', projectId) });
  }

  async knowledge(projectId: string): Promise<ProjectKnowledge | undefined> {
    return this.d.store.getKnowledge<ProjectKnowledge>(projectId);
  }

  /** Drive a task until it finishes or needs a human. */
  async run(taskId: string, o: { maxSteps?: number; waitOnPause?: boolean } = {}): Promise<Task> {
    const maxSteps = o.maxSteps ?? 200;
    for (let i = 0; i < maxSteps; i++) {
      const out = await this.step(taskId);
      if (out === 'paused') {
        const t = await this.mustGet(taskId);
        if (t.waitReason === 'subtasks') {
          // In-process mode: run ready subtasks concurrently, then let the parent integrate them.
          if (await this.driveChildren(t, o)) continue;
          break; // children wait for a human (approval / blocked)
        }
      }
      if (out === 'paused' && o.waitOnPause) {
        const t = await this.mustGet(taskId);
        const slack = t.waitReason === 'usage_limit' ? 30_000 : 0;
        const ms = Math.max(0, Date.parse(t.pausedUntil ?? '') - Date.now()) + slack;
        this.log(`[${taskId}] ${t.waitReason === 'ci' ? 'waiting for CI' : 'usage limit reached, waiting'} until ${t.pausedUntil}`);
        await sleep(ms);
        continue;
      }
      if (out !== 'continue') break;
    }
    return (await this.d.store.getTask(taskId))!;
  }

  async approve(taskId: string, answer: string): Promise<Task> {
    const task = await this.mustGet(taskId);
    if (task.state !== 'AWAITING_APPROVAL' || !task.approval) throw new DevPilotError(`task ${taskId} is not awaiting approval`, 'BAD_STATE');
    const a = task.approval;
    const patched: Task = {
      ...task,
      approval: { ...a, answer, answeredAt: nowIso() },
      approvalsGranted: [...task.approvalsGranted, a.kind],
      humanInput: [...task.humanInput, { kind: a.kind, text: answer, at: nowIso() }],
    };
    return this.commit(task, patched, a.resumeState, `approved by human: ${a.kind}`, { clearApproval: true });
  }

  async cancel(taskId: string, reason = 'cancelled by user'): Promise<Task> {
    const task = await this.mustGet(taskId);
    for (const s of task.subtasks ?? []) {
      const c = s.taskId ? await this.d.store.getTask(s.taskId) : undefined;
      if (c && !isTerminal(c.state)) await this.cancel(c.id, `parent ${task.id} cancelled`);
    }
    return this.commit(task, task, 'CANCELLED', reason);
  }

  /** Human unblocks a BLOCKED task, optionally granting more repair attempts. */
  async resume(taskId: string, o: { note?: string; extraRepairAttempts?: number } = {}): Promise<Task> {
    const task = await this.mustGet(taskId);
    if (task.state !== 'BLOCKED') throw new DevPilotError(`task ${taskId} is not blocked`, 'BAD_STATE');
    const policy = (await this.ctx(task.projectId)).policy.project;
    const patched: Task = {
      ...task,
      stopReason: undefined,
      stepFailures: {},
      extraRepairAttempts: task.extraRepairAttempts + (o.extraRepairAttempts ?? policy.limits.max_repair_attempts),
      resumedAtAttempt: task.repairAttempts,
      humanInput: o.note ? [...task.humanInput, { kind: 'resume', text: o.note, at: nowIso() }] : task.humanInput,
    };
    // Re-verify from scratch: maybe the human fixed the environment or the code.
    const pendingSubtasks = task.subtasks?.some((x) => !x.integratedCommit);
    const to: TaskState = pendingSubtasks ? 'EXECUTING_SUBTASKS' : task.requirements.length === 0 ? 'SPECIFICATION' : task.checkpoints.qa || task.subtasks ? 'VALIDATION' : 'IMPLEMENTATION';
    const saved = await this.commit(task, patched, to, 'resumed by human');
    // Unblocking a subtask also unblocks the parent that stopped because of it.
    if (task.parentId) {
      const parent = await this.d.store.getTask(task.parentId);
      if (parent?.state === 'BLOCKED') await this.resume(parent.id, { note: `subtask ${task.id} resumed` });
    }
    return saved;
  }

  // ------------------------------------------------------------- engine --
  async step(taskId: string): Promise<StepOutcome> {
    const store = this.d.store;
    if (!(await store.acquireLease(taskId, this.workerId, this.leaseMs))) return 'busy';
    const hb = setInterval(() => void store.acquireLease(taskId, this.workerId, this.leaseMs).catch(() => {}), Math.max(200, this.leaseMs / 3));
    hb.unref();
    this.heartbeats.add(hb);
    try {
      const task = await this.mustGet(taskId);
      if (isTerminal(task.state)) return 'terminal';
      if (isWaiting(task.state)) return 'waiting';
      if (task.pausedUntil && task.waitReason !== 'subtasks' && Date.parse(task.pausedUntil) > Date.now()) return 'paused';

      const ctx = await this.ctx(task.projectId);
      const limitStop = this.checkGlobalLimits(task, ctx.policy);
      if (limitStop) {
        await this.commit(task, { ...task, stopReason: limitStop }, 'BLOCKED', limitStop);
        return 'waiting';
      }
      const budgetUntil = await this.dailyBudgetPause(task, ctx.policy);
      if (budgetUntil) {
        await this.save(task, { ...task, pausedUntil: new Date(budgetUntil).toISOString(), waitReason: 'budget' });
        return 'paused';
      }

      await store.appendEvent(task.id, 'step_started', { state: task.state, worker: this.workerId });
      this.log(`[${task.id}] ${task.state}`);
      let res: Step;
      try {
        res = await this.handle(task, ctx);
      } catch (e: any) {
        if (e instanceof DevPilotError && e.code === 'VERSION_CONFLICT') return 'busy';
        if (e instanceof RateLimited) {
          const latest = await this.mustGet(task.id);
          const until = new Date(e.until).toISOString();
          await store.appendEvent(task.id, 'paused_usage_limit', { state: task.state, until });
          if (!ctx.policy.project.agents.wait_on_rate_limit) {
            await this.commit(latest, { ...latest, stopReason: `subscription usage limit until ${until}` }, 'BLOCKED', 'usage limit');
            return 'waiting';
          }
          await this.save(latest, { ...latest, pausedUntil: until, waitReason: 'usage_limit' });
          return 'paused';
        }
        const fails = (task.stepFailures[task.state] ?? 0) + 1;
        const msg = e?.message ?? String(e);
        await store.appendEvent(task.id, 'step_failed', { state: task.state, error: msg, attempt: fails });
        this.log(`[${task.id}] step failed (${fails}/${MAX_STEP_FAILURES}): ${msg}`);
        const latest = await this.mustGet(task.id);
        const patched = { ...latest, stepFailures: { ...latest.stepFailures, [task.state]: fails } };
        if (fails >= MAX_STEP_FAILURES) {
          await this.commit(latest, { ...patched, stopReason: `${task.state} failed ${fails} times: ${msg}` }, 'BLOCKED', msg);
          return 'waiting';
        }
        await this.save(latest, patched);
        return 'continue';
      }

      const latest = await this.mustGet(task.id); // agent bookkeeping may have bumped the version
      const merged: Task = {
        ...latest,
        ...res.patch,
        pausedUntil: res.pause ? new Date(res.pause.until).toISOString() : undefined,
        waitReason: res.pause?.reason,
        stepFailures: { ...latest.stepFailures, [task.state]: 0 },
      };
      if (!res.to) {
        await this.save(latest, merged);
        return res.pause ? 'paused' : 'continue';
      }
      const saved = await this.commit(latest, merged, res.to, res.reason);
      if (saved.state === 'DONE' && !saved.parentId) await this.remember(saved, ctx).catch((e) => this.log(`[${saved.id}] knowledge not recorded: ${e.message}`));
      if (saved.parentId && (isTerminal(saved.state) || isWaiting(saved.state))) await this.d.onTaskReady?.(saved.parentId);
      return isTerminal(saved.state) ? 'terminal' : isWaiting(saved.state) ? 'waiting' : 'continue';
    } finally {
      const alive = this.heartbeats.delete(hb);
      clearInterval(hb);
      if (alive) await store.releaseLease(taskId, this.workerId);
    }
  }

  private checkGlobalLimits(task: Task, policy: LoadedPolicy): string | undefined {
    const l = policy.project.limits;
    if (task.costUsd >= l.max_task_cost_usd) return `budget exhausted: $${task.costUsd.toFixed(2)} >= $${l.max_task_cost_usd}`;
    if (task.startedAt) {
      const mins = (Date.now() - Date.parse(task.startedAt)) / 60000;
      if (mins > l.max_duration_minutes) return `duration limit: ${mins.toFixed(0)}min > ${l.max_duration_minutes}min`;
    }
    return undefined;
  }

  /** Project daily budget: returns the time to resume (next midnight) when today's spend is used up. */
  private async dailyBudgetPause(task: Task, policy: LoadedPolicy): Promise<number | undefined> {
    const cap = policy.project.limits.max_daily_cost_usd;
    if (!cap) return undefined;
    const spent = await spentToday(this.d.store, task.projectId);
    if (spent < cap) return undefined;
    const next = new Date();
    next.setHours(24, 0, 5, 0);
    await this.d.store.appendEvent(task.id, 'paused_daily_budget', { spent, cap, until: next.toISOString() });
    return next.getTime();
  }

  /** Model + effort for a role: explicit per-role override > complexity tier > default. */
  private pickModel(task: Task, role: AgentRole, pol: LoadedPolicy['project']): { model: string; effort: LoadedPolicy['project']['agents']['effort']; tier?: string } {
    const a = pol.agents;
    if (a.models[role]) return { model: a.models[role]!, effort: a.effort };
    const r = a.routing;
    if (!r.enabled || !task.complexity || !r.tiers.length) return { model: a.model, effort: a.effort };
    let i = r.tiers.findIndex((t) => t.max_score === undefined || task.complexity!.score <= t.max_score);
    if (i < 0) i = r.tiers.length - 1;
    if (r.top_tier_roles.includes(role)) i = r.tiers.length - 1;
    if (role === 'fixer' && task.repairAttempts >= r.escalate_fixer_after) i = Math.min(r.tiers.length - 1, i + 1);
    const t = r.tiers[i]!;
    return { model: t.model, effort: t.effort, tier: t.name };
  }

  private async handle(task: Task, ctx: ProjectCtx): Promise<Step> {
    switch (task.state) {
      case 'QUEUED':
        return this.onQueued(task, ctx);
      case 'DISCOVERY':
        return this.onDiscovery(task, ctx);
      case 'SPECIFICATION':
        return this.onSpecification(task, ctx);
      case 'IMPACT_ANALYSIS':
        return this.onImpact(task, ctx);
      case 'IMPLEMENTATION':
        return this.onImplementation(task, ctx);
      case 'VALIDATION':
        return this.onValidation(task, ctx);
      case 'REVIEW':
        return this.onReview(task, ctx);
      case 'REPAIR':
        return this.onRepair(task, ctx);
      case 'DECOMPOSITION':
        return this.onDecomposition(task);
      case 'EXECUTING_SUBTASKS':
        return this.onExecutingSubtasks(task, ctx);
      case 'DELIVERY':
        return this.onDelivery(task, ctx);
      default:
        throw new DevPilotError(`no handler for ${task.state}`, 'NO_HANDLER');
    }
  }

  // ------------------------------------------------------------ handlers --
  private async onQueued(task: Task, ctx: ProjectCtx): Promise<Step> {
    // Subtasks branch from the parent's integration head (which already contains their dependencies).
    const wt = await ctx.git.ensureWorktree(task.id, task.baseRef ?? ctx.project.defaultBranch);
    await this.d.store.appendEvent(task.id, 'worktree_ready', { ...wt });
    return {
      patch: { worktreePath: wt.path, branch: wt.branch, baseCommit: wt.baseCommit, headCommit: wt.baseCommit, startedAt: task.startedAt ?? nowIso() },
      to: task.parentId ? 'IMPACT_ANALYSIS' : 'DISCOVERY',
    };
  }

  /** Commit-bound index; unchanged files are reused from the per-project blob cache. */
  private async index(task: Task, ctx: ProjectCtx): Promise<ProjectIndex> {
    const idx = await buildIndex(task.worktreePath!, { testGlobs: ctx.policy.project.paths.tests, cacheDir: join(this.d.dataDir, 'index', ctx.project.id) });
    if (idx.commit !== (await head(task.worktreePath!))) throw new DevPilotError('index does not match HEAD', 'STALE_INDEX');
    await this.d.store.appendEvent(task.id, 'index_built', { commit: idx.commit, ...idx.stats });
    return idx;
  }

  private async knowledgeFor(task: Task, terms: string[], files: string[]) {
    const k = await this.d.store.getKnowledge<ProjectKnowledge>(task.projectId);
    return featureMemory(relevantKnowledge(k, { terms, files }).filter((f) => f.taskId !== task.id));
  }

  private async onDiscovery(task: Task, ctx: ProjectCtx): Promise<Step> {
    const idx = await this.index(task, ctx);
    const prelim = buildContext(idx, { terms: [task.prompt], limit: 30 });
    const out = await this.agent(task, ctx, 'researcher', P.discoveryPrompt(task, summarize(idx), prelim.files.length ? formatContext(prelim, 30) : ''), DiscoveryOutput);
    // Systematic, deterministic expansion around what the researcher found.
    const full = buildContext(idx, { terms: [task.prompt, ...out.searchTerms], seeds: out.relevantFiles });
    const discovery = { ...out, context: formatContext(full), contextFiles: full.files.map((f) => f.file) };
    await this.d.store.appendEvent(task.id, 'context_built', { files: full.files.length, endpoints: full.endpoints.length, tables: full.tables.length, tests: full.tests.length });
    return { patch: { discovery }, to: 'SPECIFICATION' };
  }

  private async onSpecification(task: Task, ctx: ProjectCtx): Promise<Step> {
    const memory = await this.knowledgeFor(task, [task.prompt, ...(task.discovery?.searchTerms ?? [])], task.discovery?.contextFiles ?? []);
    const out = await this.agent(task, ctx, 'architect', P.specPrompt(task, memory), SpecOutput);
    const requirements = out.requirements.map((r) => ({ ...r, status: 'pending' as const, tests: [] }));
    const patch: Partial<Task> = { requirements, title: task.title || out.title, assumptions: out.assumptions };
    const blocking = out.ambiguities.filter((a) => a.blocking);
    if (blocking.length && !task.approvalsGranted.includes('ambiguity')) {
      return {
        patch: { ...patch, approval: this.approval('ambiguity', 'Requirements are ambiguous', blocking.map((b) => b.question), 'SPECIFICATION') },
        to: 'AWAITING_APPROVAL',
        reason: 'blocking ambiguities',
      };
    }
    if (ctx.policy.project.approval.spec === 'required' && !task.approvalsGranted.includes('spec')) {
      return {
        patch: { ...patch, approval: this.approval('spec', 'Policy requires approval of the specification', requirements.map((r) => `${r.id}: ${r.description}`), 'IMPACT_ANALYSIS') },
        to: 'AWAITING_APPROVAL',
      };
    }
    return { patch, to: 'IMPACT_ANALYSIS' };
  }

  private async onImpact(task: Task, ctx: ProjectCtx): Promise<Step> {
    const idx = await this.index(task, ctx);
    const memory = await this.knowledgeFor(task, [task.prompt, ...task.requirements.map((r) => r.description)], task.discovery?.contextFiles ?? []);
    const out = await this.agent(task, ctx, 'architect', P.impactPrompt(task, summarize(idx), memory), ImpactOutput);
    // Deterministic expansion: the model names files; the import graph and shared tables find their consumers.
    const dependentFiles = dependents(idx, out.filesToChange);
    const relatedData = dataNeighbours(idx, out.filesToChange).map((n) => `table "${n.table}": ${n.files.join(', ')}`);
    const { subtasks: proposed, ...plan } = out;
    const impact = { ...plan, dependentFiles, relatedData, affectedTests: affectedTests(idx, out.filesToChange) };
    // Large task -> validated subtask graph (deterministic checks; invalid plans are rejected and re-planned).
    let subtasks: Subtask[] | undefined;
    if (!task.parentId && ctx.policy.project.decomposition.enabled && proposed.length >= 2) {
      const chk = validatePlan(proposed, task.requirements, ctx.policy.project.decomposition.max_subtasks);
      subtasks = chk.subtasks;
      await this.d.store.appendEvent(task.id, 'plan_validated', { subtasks: subtasks.map((x) => ({ key: x.key, dependsOn: x.dependsOn })), serialized: chk.serialized });
    }
    const next: TaskState = subtasks ? 'DECOMPOSITION' : 'IMPLEMENTATION';
    const factors = {
      files: out.filesToChange.length,
      dependents: Math.ceil(dependentFiles.length / 3),
      requirements: task.requirements.length,
      highRisk: isHighRisk(ctx.policy.project, out.filesToChange).length || out.touchesDatabase || out.touchesAuth ? 3 : 0,
      publicApi: out.touchesPublicApi ? 2 : 0,
      subtasks: (subtasks?.length ?? 0) * 2,
    };
    const complexity = { score: Object.values(factors).reduce((x, y) => x + y, 0), factors };
    await this.d.store.appendEvent(task.id, 'complexity_scored', complexity);
    const risky = isHighRisk(ctx.policy.project, out.filesToChange);
    const highRisk = risky.length > 0 || out.touchesDatabase || out.touchesAuth;
    if (highRisk && ctx.policy.project.approval.high_risk_changes === 'required' && !task.approvalsGranted.includes('high_risk')) {
      const why = [...risky.map((f) => `high-risk path: ${f}`), out.touchesDatabase ? 'database changes' : '', out.touchesAuth ? 'authentication/authorization changes' : ''].filter(Boolean);
      return {
        patch: { impact, subtasks, complexity, approval: this.approval('high_risk', 'Plan contains high-risk changes', [...why, ...out.plan], next) },
        to: 'AWAITING_APPROVAL',
      };
    }
    return { patch: { impact, subtasks, complexity }, to: next };
  }

  private async onDecomposition(task: Task): Promise<Step> {
    const dir = join(this.d.dataDir, 'artifacts', task.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'subtasks.json'), JSON.stringify(task.subtasks, null, 2));
    return { to: 'EXECUTING_SUBTASKS', reason: `${task.subtasks!.length} subtasks` };
  }

  /** Create a subtask: inherits research, requirements subset, decisions and approvals of the parent. */
  private async spawnSubtask(parent: Task, s: Subtask, baseRef: string): Promise<Task> {
    const others = (parent.subtasks ?? []).filter((x) => x.key !== s.key).map((x) => `${x.key}: ${x.title}`);
    const child: Task = {
      ...(await this.createTask({ projectId: parent.projectId, title: `[${s.key}] ${s.title}`, prompt: `${s.title}\n\n${s.description}\n\nThis is subtask ${s.key} of ${parent.id} "${parent.title}". Other parts are implemented separately — do NOT implement them: ${others.join('; ') || '-'}.\nExpected files: ${s.files.join(', ') || '-'}` })),
    };
    const patched: Task = {
      ...child,
      parentId: parent.id,
      subtaskKey: s.key,
      baseRef,
      requirements: parent.requirements.filter((r) => s.requirementIds.includes(r.id)).map((r) => ({ ...r, status: 'pending' as const, tests: [] })),
      discovery: parent.discovery,
      assumptions: parent.assumptions,
      humanInput: parent.humanInput,
      approvalsGranted: parent.approvalsGranted.filter((k) => k !== 'before_pr'),
    };
    const saved = await this.save(child, patched);
    await this.d.store.appendEvent(parent.id, 'subtask_spawned', { key: s.key, taskId: saved.id, baseRef });
    await this.d.onTaskReady?.(saved.id);
    return saved;
  }

  private async onExecutingSubtasks(task: Task, ctx: ProjectCtx): Promise<Step> {
    const wt = task.worktreePath!;
    const dec = ctx.policy.project.decomposition;
    const subtasks = task.subtasks!.map((x) => ({ ...x }));
    const requirements = task.requirements.map((r) => ({ ...r, tests: [...r.tests] }));
    const kids = new Map<string, Task>();
    for (const s of subtasks) if (s.taskId) kids.set(s.key, (await this.d.store.getTask(s.taskId))!);
    const patch = (): Partial<Task> => ({ subtasks, requirements });

    // 1. Integrate finished subtasks, in dependency order, into the integration branch.
    for (const s of topoOrder(subtasks)) {
      const child = kids.get(s.key);
      if (!child || child.state !== 'DONE' || s.integratedCommit) continue;
      if (s.dependsOn.some((d) => !subtasks.find((x) => x.key === d)!.integratedCommit)) continue;
      let m = await mergeBranch(wt, child.branch!, `devpilot(${task.id}): integrate ${s.key} ${child.id}`);
      if (!m.ok) {
        await this.d.store.appendEvent(task.id, 'integration_conflict', { key: s.key, files: m.conflicts });
        let remaining = m.conflicts;
        for (let attempt = 1; attempt <= dec.max_conflict_attempts && remaining.length; attempt++) {
          const integrated = subtasks.filter((x) => x.integratedCommit).map((x) => `${x.key}: ${x.title}`);
          await this.agent(task, ctx, 'integrator', P.integratorPrompt(task, s, child, remaining, integrated), IntegratorOutput);
          remaining = await filesWithConflictMarkers(wt, m.conflicts);
        }
        if (remaining.length) {
          await abortMerge(wt);
          const reason = `could not resolve merge conflicts integrating ${s.key} (${child.id}): ${remaining.join(', ')}`;
          return { patch: { ...patch(), stopReason: reason }, to: 'BLOCKED', reason };
        }
        m = { ok: true, head: await concludeMerge(wt), conflicts: m.conflicts };
        await this.d.store.appendEvent(task.id, 'integration_conflict_resolved', { key: s.key, files: m.conflicts, head: m.head });
      }
      s.integratedCommit = m.head;
      s.conflicts = m.conflicts.length ? m.conflicts : undefined;
      for (const cr of child.requirements) {
        const r = requirements.find((x) => x.id === cr.id);
        if (r) r.tests = [...new Set([...r.tests, ...cr.tests])];
      }
      await this.d.store.appendEvent(task.id, 'subtask_integrated', { key: s.key, taskId: child.id, head: m.head, conflicts: m.conflicts.length });
    }

    // 2. A failed subtask stops the parent (a human resumes the subtask, which resumes the parent).
    for (const s of subtasks) {
      const c = kids.get(s.key);
      if (c && ['BLOCKED', 'FAILED', 'CANCELLED'].includes(c.state)) {
        const reason = `subtask ${s.key} (${c.id}) is ${c.state}${c.stopReason ? `: ${c.stopReason}` : ''}`;
        return { patch: { ...patch(), stopReason: reason }, to: 'BLOCKED', reason };
      }
    }

    // 3. Everything integrated -> verify the assembled result like any other change.
    if (subtasks.every((x) => x.integratedCommit)) {
      return { patch: { ...patch(), headCommit: await head(wt) }, to: 'VALIDATION', reason: 'all subtasks integrated; re-verifying the integrated result' };
    }

    // 4. Start subtasks whose dependencies are integrated, up to the parallelism limit.
    const running = subtasks.filter((x) => x.taskId && !x.integratedCommit).length;
    let slots = ctx.policy.project.execution.max_parallel_agents - running;
    for (const s of topoOrder(subtasks)) {
      if (slots <= 0) break;
      if (s.taskId || s.dependsOn.some((d) => !subtasks.find((x) => x.key === d)!.integratedCommit)) continue;
      const child = await this.spawnSubtask({ ...task, subtasks }, s, await head(wt));
      s.taskId = child.id;
      slots--;
    }
    return { patch: patch(), pause: { until: Date.now() + dec.poll_seconds * 1000, reason: 'subtasks' } };
  }

  /** In-process: run every runnable subtask of `parent` concurrently. Returns true if anything moved. */
  private async driveChildren(parent: Task, o: { waitOnPause?: boolean }): Promise<boolean> {
    const ids = (parent.subtasks ?? []).map((s) => s.taskId).filter((x): x is string => !!x);
    const before = new Map<string, number>();
    const runnable: string[] = [];
    for (const id of ids) {
      const c = (await this.d.store.getTask(id))!;
      before.set(id, c.version);
      if (!isTerminal(c.state) && !isWaiting(c.state)) runnable.push(id);
    }
    await Promise.all(runnable.map((id) => this.run(id, o)));
    for (const id of ids) if ((await this.d.store.getTask(id))!.version !== before.get(id)) return true;
    return false;
  }

  private async onImplementation(task: Task, ctx: ProjectCtx): Promise<Step> {
    const wt = task.worktreePath!;
    let checkpoints = { ...task.checkpoints };
    if (!checkpoints.developer) {
      const out = await this.agent(task, ctx, 'developer', P.developerPrompt(task), DeveloperOutput);
      const c = await commitAll(wt, `devpilot(${task.id}): implement\n\n${out.summary}`);
      checkpoints.developer = c.head;
      await this.d.store.appendEvent(task.id, 'checkpoint', { step: 'developer', head: c.head, committed: c.committed, claims: out });
      const latest = await this.mustGet(task.id);
      task = await this.save(latest, { ...latest, checkpoints });
    }
    const qa = await this.agent(task, ctx, 'qa', P.qaPrompt(task), QaOutput);
    const c = await commitAll(wt, `devpilot(${task.id}): tests`);
    checkpoints = { ...task.checkpoints, qa: c.head };
    const requirements = task.requirements.map((r) => ({
      ...r,
      status: 'implemented' as const,
      tests: [...new Set(qa.requirementTests.filter((m) => m.requirementId === r.id).flatMap((m) => m.testFiles))],
    }));
    return { patch: { requirements, checkpoints, headCommit: c.head }, to: 'VALIDATION' };
  }

  private async onValidation(task: Task, ctx: ProjectCtx): Promise<Step> {
    const wt = task.worktreePath!;
    // Anything left uncommitted is part of what we verify.
    await commitAll(wt, `devpilot(${task.id}): snapshot before validation`);
    const v = await verify({ task, policy: ctx.policy.project, worktree: wt, executor: ctx.executor, artifactsDir: join(this.d.dataDir, 'artifacts') });
    await this.d.store.appendEvent(task.id, 'gates_evaluated', {
      head: v.head,
      gates: Object.fromEntries(Object.values(v.gates).map((g) => [g.name, { status: g.status, required: g.required, reason: g.reason }])),
    });
    // Current results are the truth: older gate defects are superseded.
    const defects = task.defects.map((d) => (d.source === 'gate' && !d.resolved ? { ...d, resolved: true } : d));
    const patch: Partial<Task> = { gates: v.gates, requirements: v.requirements, headCommit: v.head, defects: [...defects, ...v.defects] };

    if (v.notVerified.length) {
      const reason = `cannot verify required gates: ${v.notVerified.map((g) => `${g.name} (${g.reason})`).join('; ')}`;
      return { patch: { ...patch, stopReason: reason }, to: 'BLOCKED', reason };
    }
    if (v.defects.length) return { patch, to: 'REPAIR', reason: `${v.defects.length} gates failed` };
    const reviewRequired = v.gates.independent_review?.required;
    if (reviewRequired && v.gates.independent_review!.status !== 'passed') return { patch, to: 'REVIEW' };
    return { patch, to: 'DELIVERY' };
  }

  private async onReview(task: Task, ctx: ProjectCtx): Promise<Step> {
    const wt = task.worktreePath!;
    const commit = await head(wt);
    const d = await diff(wt, task.baseCommit!);
    const diffText = d.length > 150_000 ? d.slice(0, 150_000) + '\n… (diff truncated; read files directly)' : d;
    // Who uses what this diff changed — especially consumers the change did not touch.
    const idx = await this.index(task, ctx);
    const changed = (await changedFiles(wt, task.baseCommit!)).map((c) => c.path);
    const consumers = consumersOfChange(idx, parseHunks(await git(wt, ['diff', '-U0', '--no-color', `${task.baseCommit}..HEAD`])), changed);
    const data = dataNeighbours(idx, changed);
    const blast = [
      ...consumers.map((c) => `- ${c.symbol.file} \`${c.symbol.symbol}\` (${c.symbol.kind}) is used by: ${c.consumers.map((u) => `${u.file}${u.changed ? '' : ' [NOT changed in this diff]'}`).join(', ')}`),
      ...data.map((n) => `- table "${n.table}" is also used by: ${n.files.join(', ')}`),
    ].join('\n');
    const out = await this.agent(task, ctx, 'reviewer', P.reviewerPrompt(task, diffText, blast), ReviewOutput);
    if ((await head(wt)) !== commit) throw new DevPilotError('reviewer created commits', 'POLICY_VIOLATION');
    if (!(await isClean(wt))) {
      // Read-only role left changes behind (e.g. via Bash): discard, never ship them.
      await git(wt, ['reset', '--hard', commit]);
      await git(wt, ['clean', '-fd']);
      await this.d.store.appendEvent(task.id, 'policy_violation', { role: 'reviewer', action: 'discarded worktree changes' });
    }
    const { gate, defects } = recordReview(task, commit, out.findings, out.unmetRequirements);
    await this.d.store.appendEvent(task.id, 'review_recorded', { status: gate.status, findings: out.findings.length, blocking: defects.length });
    const old = task.defects.map((x) => (x.source === 'review' && !x.resolved ? { ...x, resolved: true } : x));
    const patch: Partial<Task> = { gates: { ...task.gates, independent_review: gate }, defects: [...old, ...defects] };
    return gate.status === 'passed' ? { patch, to: 'DELIVERY' } : { patch, to: 'REPAIR', reason: gate.reason };
  }

  private async onRepair(task: Task, ctx: ProjectCtx): Promise<Step> {
    const l = ctx.policy.project.limits;
    const open = task.defects.filter((d) => !d.resolved);
    const maxAttempts = l.max_repair_attempts + task.extraRepairAttempts;
    const stop = (reason: string): Step => ({ patch: { stopReason: reason }, to: 'BLOCKED', reason });

    if (open.length === 0) return { to: 'VALIDATION', reason: 'no open defects' };
    if (task.repairAttempts >= maxAttempts) return stop(`repair attempts exhausted (${task.repairAttempts}/${maxAttempts})`);

    // Same failure again and again -> the agent is stuck.
    const recent = task.defects.filter((d) => d.foundInAttempt >= task.resumedAtAttempt);
    for (const d of open) {
      const n = recent.filter((x) => x.fingerprint === d.fingerprint).length;
      if (n >= l.max_same_failure) return stop(`same failure repeated ${n} times: ${d.summary}`);
    }
    // No progress: open defect count did not go down for N attempts in a row.
    const hist = [...task.repairHistory.filter((h) => h.attempt >= task.resumedAtAttempt), { attempt: task.repairAttempts, openDefects: open.length, fingerprints: open.map((d) => d.fingerprint) }];
    const window = hist.slice(-(l.max_no_progress_attempts + 1));
    if (window.length > l.max_no_progress_attempts && window.every((h, i) => i === 0 || h.openDefects >= window[i - 1]!.openDefects))
      return stop(`no progress in ${l.max_no_progress_attempts} repair attempts (${window.map((h) => h.openDefects).join(' → ')} open defects)`);

    const out = await this.agent(task, ctx, 'fixer', P.fixerPrompt(task, open), FixerOutput);
    const c = await commitAll(task.worktreePath!, `devpilot(${task.id}): repair #${task.repairAttempts + 1}\n\n${out.summary}`);
    await this.d.store.appendEvent(task.id, 'repair_applied', { attempt: task.repairAttempts + 1, committed: c.committed, head: c.head, claims: out });
    const latest = await this.mustGet(task.id);
    return {
      patch: {
        repairAttempts: task.repairAttempts + 1,
        headCommit: c.head,
        repairHistory: [...latest.repairHistory, { attempt: task.repairAttempts, openDefects: open.length, fingerprints: open.map((d) => d.fingerprint) }],
      },
      to: 'VALIDATION',
      reason: 'repair applied, re-validating everything',
    };
  }

  private async onDelivery(task: Task, ctx: ProjectCtx): Promise<Step> {
    const pol = ctx.policy.project;
    const dl = pol.delivery;
    const wt = task.worktreePath!;
    const store = this.d.store;
    if (!task.parentId && pol.approval.before_pr === 'required' && !task.approvalsGranted.includes('before_pr')) {
      return { patch: { approval: this.approval('before_pr', 'Policy requires approval before opening a PR', ['Review the report and approve to open the PR'], 'DELIVERY') }, to: 'AWAITING_APPROVAL' };
    }
    const headCommit = await head(wt);
    const changes = await changedFiles(wt, task.baseCommit!);
    const runs = await store.listAgentRuns(task.id);
    const reportDir = join(this.d.dataDir, 'reports');
    mkdirSync(reportDir, { recursive: true });
    const reportPath = join(reportDir, `${task.id}.md`);
    const subtaskRows = await Promise.all((task.subtasks ?? []).map(async (x) => ({ ...x, child: x.taskId ? await store.getTask(x.taskId) : undefined })));
    const body = renderReport({ ...task, headCommit }, runs, changes, subtaskRows);
    writeFileSync(reportPath, body);
    // A verified subtask is delivered to its parent's integration branch, not to a PR.
    if (task.parentId) return { patch: { reportPath }, to: 'DONE', reason: `ready for integration into ${task.parentId}` };

    if (!dl.create_pr) {
      await store.appendEvent(task.id, 'delivered_locally', { branch: task.branch, reason: 'delivery.create_pr is false' });
      return { patch: { reportPath }, to: 'DONE', reason: `branch ${task.branch}` };
    }
    if (!(await hasRemote(ctx.project.repoPath, dl.remote))) {
      const reason = `delivery.create_pr is on but the repository has no remote "${dl.remote}"`;
      return { patch: { reportPath, stopReason: reason }, to: 'BLOCKED', reason };
    }

    // 1. Push the verified commit (again after every repair).
    const checkpoints = { ...task.checkpoints };
    if (checkpoints.pushed !== headCommit) {
      await push(wt, dl.remote, task.branch!);
      checkpoints.pushed = headCommit;
      checkpoints.ci_since = nowIso();
      await store.appendEvent(task.id, 'pushed', { head: headCommit, remote: dl.remote });
    }
    // 2. Open the PR once (idempotent across crashes); refresh its report afterwards.
    let prUrl = task.prUrl ?? (await findPullRequest(wt, task.branch!));
    if (!prUrl) {
      prUrl = await createPullRequest({ cwd: wt, base: ctx.project.defaultBranch, branch: task.branch!, title: `[DevPilot] ${task.title}`, body, draft: dl.draft_pr });
      checkpoints.pr_body = headCommit;
      await store.appendEvent(task.id, 'pr_created', { prUrl });
    } else if (checkpoints.pr_body !== headCommit) {
      await updatePullRequestBody(wt, prUrl, body);
      checkpoints.pr_body = headCommit;
    }
    const base: Partial<Task> = { reportPath, prUrl, checkpoints };
    if (!dl.require_ci) return { patch: base, to: 'DONE', reason: `PR ${prUrl}` };

    // 3. CI is a required gate bound to the pushed commit. DevPilot never merges.
    const ci = await prChecks(wt, prUrl);
    const waited = (Date.now() - Date.parse(checkpoints.ci_since ?? nowIso())) / 60_000;
    const summary = ci.checks.map((c) => `${c.bucket.padEnd(8)} ${c.workflow ? c.workflow + ' / ' : ''}${c.name}`).join('\n');
    const ciGate = (status: 'pending' | 'passed' | 'failed' | 'not_verified', reason: string) => ({
      ...task.gates,
      ci: { name: 'ci', status, required: true, commit: headCommit, ranAt: nowIso(), reason, outputTail: summary, command: `gh pr checks ${prUrl}` },
    });
    await store.appendEvent(task.id, 'ci_polled', { state: ci.state, checks: ci.checks.length, waitedMin: Number(waited.toFixed(1)) });

    if (ci.state === 'pass') return { patch: { ...base, gates: ciGate('passed', `${ci.checks.length} checks passed`) }, to: 'DONE', reason: `PR ${prUrl}, CI green` };
    if (ci.state === 'fail') {
      const failed = ci.checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
      const defects = [];
      for (const c of failed) {
        const log = await failedCheckLog(wt, c.link);
        defects.push({
          id: newId('DEF'),
          source: 'gate' as const,
          gate: 'ci',
          severity: 'blocker' as const,
          fingerprint: fingerprint(`ci:${c.name}`, log),
          summary: `CI check "${c.name}" ${c.bucket === 'cancel' ? 'was cancelled' : 'failed'} on the PR`,
          details: `check: ${c.workflow ?? ''} / ${c.name}\nlink: ${c.link ?? '-'}\n\n${log}`,
          foundInAttempt: task.repairAttempts,
          resolved: false,
        });
      }
      return { patch: { ...base, gates: ciGate('failed', `${failed.length} CI checks failed`), defects: [...task.defects, ...defects] }, to: 'REPAIR', reason: 'CI failed on the PR' };
    }
    if (ci.state === 'none' && waited > dl.ci_no_checks_grace_minutes) {
      const reason = `require_ci is on but no CI checks were reported on ${prUrl} within ${dl.ci_no_checks_grace_minutes} min`;
      return { patch: { ...base, gates: ciGate('not_verified', 'no CI checks reported'), stopReason: reason }, to: 'BLOCKED', reason };
    }
    if (waited > dl.ci_timeout_minutes) {
      const reason = `CI did not finish within ${dl.ci_timeout_minutes} min on ${prUrl}`;
      return { patch: { ...base, gates: ciGate('not_verified', 'CI timeout'), stopReason: reason }, to: 'BLOCKED', reason };
    }
    return { patch: { ...base, gates: ciGate('pending', ci.state === 'none' ? 'waiting for checks to appear' : 'checks running') }, pause: { until: Date.now() + dl.ci_poll_seconds * 1000, reason: 'ci' } };
  }

  /** Delivered work becomes long-term project knowledge (business rules + feature -> code/tests). */
  private async remember(task: Task, ctx: ProjectCtx) {
    const idx = await this.index(task, ctx);
    const files = (await changedFiles(task.worktreePath!, task.baseCommit!)).filter((c) => c.status !== 'D').map((c) => c.path);
    const k = await this.d.store.getKnowledge<ProjectKnowledge>(task.projectId);
    const next = recordFeature(k, task.projectId, {
      taskId: task.id,
      title: task.title,
      prompt: task.prompt,
      completedAt: nowIso(),
      commit: task.headCommit ?? idx.commit,
      prUrl: task.prUrl,
      requirements: task.requirements.map(({ id, description, acceptanceCriteria }) => ({ id, description, acceptanceCriteria })),
      assumptions: task.assumptions,
      decisions: task.humanInput.map((h) => h.text),
      files,
      tests: [...new Set(task.requirements.flatMap((r) => r.tests))],
      endpoints: idx.api.filter((a) => files.includes(a.file)).map((a) => `${a.method} ${a.path}`),
      tables: idx.tables.filter((t) => files.includes(t.file)).map((t) => t.name),
      terms: task.discovery?.searchTerms ?? [],
    });
    await this.d.store.saveKnowledge(task.projectId, next);
    await this.d.store.appendEvent(task.id, 'knowledge_recorded', { features: next.features.length });
  }

  // ------------------------------------------------------------- helpers --
  private approval(kind: Approval['kind'], reason: string, questions: string[], resumeState: TaskState): Approval {
    return { kind, reason, questions, resumeState, requestedAt: nowIso() };
  }

  /** Run one agent role with bookkeeping (session id persisted early, cost accounted). */
  private async agent<T>(task: Task, ctx: ProjectCtx, role: AgentRole, prompt: string, schema: z.ZodType<T>): Promise<T> {
    const pol = ctx.policy.project;
    const store = this.d.store;
    // Resume an interrupted session of the same role/state if there is one.
    const prior = (await store.listAgentRuns(task.id)).filter((r) => r.role === role && r.state === task.state && (r.status === 'running' || r.status === 'interrupted') && r.sessionId).pop();
    const run: AgentRun = {
      id: newId('RUN'),
      taskId: task.id,
      role,
      state: task.state,
      model: this.pickModel(task, role, pol).model,
      status: 'running',
      costUsd: 0,
      numTurns: 0,
      toolCalls: 0,
      deniedToolCalls: [],
      startedAt: nowIso(),
    };
    await store.saveAgentRun(run);
    if (prior) await store.saveAgentRun({ ...prior, status: 'failed', error: 'superseded by resumed run', finishedAt: nowIso() });
    await store.appendEvent(task.id, 'agent_started', { runId: run.id, role, resumeOf: prior?.sessionId ?? null });

    const remaining = Math.max(0.5, pol.limits.max_task_cost_usd - task.costUsd);
    const res = await this.d.runner.run({
      role,
      taskId: task.id,
      prompt: prior ? `${prompt}\n\n(You were interrupted. Continue from the current state of the worktree.)` : prompt,
      cwd: task.worktreePath!,
      schema,
      model: run.model!,
      effort: this.pickModel(task, role, pol).effort,
      maxTurns: pol.agents.max_turns[role] ?? 60,
      budgetUsd: remaining,
      timeoutMs: pol.limits.max_duration_minutes * 60_000,
      resumeSessionId: prior?.sessionId,
      onSession: async (sessionId) => {
        run.sessionId = sessionId;
        await store.saveAgentRun(run);
      },
      onToolDenied: (tool, reason) => {
        void store.appendEvent(task.id, 'tool_denied', { role, tool, reason });
      },
    });

    const finished: AgentRun = {
      ...run,
      sessionId: res.sessionId ?? run.sessionId,
      status: res.ok ? 'succeeded' : res.rateLimitedUntil ? 'interrupted' : 'failed',
      subtype: res.subtype,
      costUsd: res.costUsd,
      numTurns: res.numTurns,
      toolCalls: res.toolCalls,
      deniedToolCalls: res.denied,
      finishedAt: nowIso(),
      error: res.error,
    };
    await store.saveAgentRun(finished);
    const latest = await this.mustGet(task.id);
    await this.save(latest, { ...latest, costUsd: latest.costUsd + res.costUsd });
    await store.appendEvent(task.id, 'agent_finished', { runId: run.id, role, ok: res.ok, subtype: res.subtype, costUsd: res.costUsd, turns: res.numTurns, denied: res.denied.length, error: res.error ?? null });
    if (res.rateLimitedUntil) throw new RateLimited(res.rateLimitedUntil);
    if (!res.ok || res.output === undefined) throw new AgentFailure(`${role} agent failed: ${res.error ?? res.subtype}`);
    return res.output;
  }

  private async ctx(projectId: string): Promise<ProjectCtx> {
    const project = await this.d.store.getProject(projectId);
    if (!project) throw new DevPilotError(`unknown project ${projectId}`, 'NOT_FOUND');
    const policy = loadPolicy(project.policyPath, this.d.policiesDir ?? DEFAULT_POLICIES_DIR);
    const ex = policy.project.execution;
    const executor =
      this.d.executorFactory?.(policy) ??
      // Inside the DevPilot container there is no Docker socket (on purpose): the container is the sandbox.
      (ex.containerized && process.env.DEVPILOT_IN_CONTAINER !== '1'
        ? new DockerExecutor({ image: ex.container_image, network: ex.container_network, cpus: ex.container_cpus, memory: ex.container_memory, passthrough: ex.env_passthrough })
        : new LocalExecutor(ex.env_passthrough));
    return { project, policy, git: new GitManager(project.repoPath, join(this.d.dataDir, 'worktrees', project.id)), executor };
  }

  private async mustGet(id: string): Promise<Task> {
    const t = await this.d.store.getTask(id);
    if (!t) throw new DevPilotError(`task ${id} not found`, 'NOT_FOUND');
    return t;
  }

  private async save(current: Task, next: Task): Promise<Task> {
    return this.d.store.saveTask(next, current.version);
  }

  /** Guarded transition + persist + event, in that order. */
  private async commit(current: Task, next: Task, to: TaskState, reason?: string, o: { clearApproval?: boolean } = {}): Promise<Task> {
    const headCommit = next.worktreePath && existsSync(next.worktreePath) ? await head(next.worktreePath) : (next.headCommit ?? '');
    const { task: moved, event } = transition(next, to, { headCommit }, reason);
    const finalTask: Task = o.clearApproval ? { ...moved, approval: undefined } : moved;
    const saved = await this.save(current, finalTask);
    await this.d.store.appendEvent(current.id, event.type, event.data);
    this.log(`[${current.id}] ${event.data.from} -> ${event.data.to}${reason ? ` (${reason})` : ''}`);
    return saved;
  }
}
