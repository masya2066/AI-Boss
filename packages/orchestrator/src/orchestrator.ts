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
  type Task,
  type TaskState,
} from '@devpilot/shared';
import type { Store } from '@devpilot/database';
import { isTerminal, isWaiting, transition } from '@devpilot/task-engine';
import { loadPolicy, isHighRisk, DEFAULT_POLICIES_DIR, type LoadedPolicy } from '@devpilot/policy-engine';
import { GitManager, changedFiles, commitAll, createPullRequest, diff, failedCheckLog, findPullRequest, git, hasRemote, head, isClean, prChecks, push, updatePullRequestBody } from '@devpilot/git-manager';
import { DockerExecutor, LocalExecutor, type Executor } from '@devpilot/sandbox-manager';
import { fingerprint, recordReview, verify } from '@devpilot/verification-engine';
import { affectedTests, buildIndex, dependents, summarize } from '@devpilot/project-intelligence';
import {
  DeveloperOutput,
  DiscoveryOutput,
  FixerOutput,
  ImpactOutput,
  QaOutput,
  ReviewOutput,
  SpecOutput,
  type AgentRunner,
} from '@devpilot/agent-runtime';
import * as P from './prompts';
import { renderReport } from './report';

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
  pause?: { until: number; reason: 'ci' | 'usage_limit' };
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

  constructor(private readonly d: OrchestratorDeps) {
    this.workerId = d.workerId ?? `worker-${process.pid}`;
    this.log = d.log ?? (() => {});
    this.leaseMs = d.leaseMs ?? 120_000;
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

  /** Drive a task until it finishes or needs a human. */
  async run(taskId: string, o: { maxSteps?: number; waitOnPause?: boolean } = {}): Promise<Task> {
    const maxSteps = o.maxSteps ?? 200;
    for (let i = 0; i < maxSteps; i++) {
      const out = await this.step(taskId);
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
    const to: TaskState = task.requirements.length === 0 ? 'SPECIFICATION' : task.checkpoints.qa ? 'VALIDATION' : 'IMPLEMENTATION';
    return this.commit(task, patched, to, 'resumed by human');
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
      if (task.pausedUntil && Date.parse(task.pausedUntil) > Date.now()) return 'paused';

      const ctx = await this.ctx(task.projectId);
      const limitStop = this.checkGlobalLimits(task, ctx.policy);
      if (limitStop) {
        await this.commit(task, { ...task, stopReason: limitStop }, 'BLOCKED', limitStop);
        return 'waiting';
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
      case 'DELIVERY':
        return this.onDelivery(task, ctx);
      default:
        throw new DevPilotError(`no handler for ${task.state}`, 'NO_HANDLER');
    }
  }

  // ------------------------------------------------------------ handlers --
  private async onQueued(task: Task, ctx: ProjectCtx): Promise<Step> {
    const wt = await ctx.git.ensureWorktree(task.id, ctx.project.defaultBranch);
    await this.d.store.appendEvent(task.id, 'worktree_ready', { ...wt });
    return {
      patch: { worktreePath: wt.path, branch: wt.branch, baseCommit: wt.baseCommit, headCommit: wt.baseCommit, startedAt: task.startedAt ?? nowIso() },
      to: 'DISCOVERY',
    };
  }

  private async index(task: Task, ctx: ProjectCtx) {
    const idx = await buildIndex(task.worktreePath!, ctx.policy.project.paths.tests);
    const dir = join(this.d.dataDir, 'artifacts', task.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `index-${idx.commit.slice(0, 12)}.json`), JSON.stringify(idx));
    return idx;
  }

  private async onDiscovery(task: Task, ctx: ProjectCtx): Promise<Step> {
    const idx = await this.index(task, ctx);
    const out = await this.agent(task, ctx, 'researcher', P.discoveryPrompt(task, summarize(idx)), DiscoveryOutput);
    return { patch: { discovery: out }, to: 'SPECIFICATION' };
  }

  private async onSpecification(task: Task, ctx: ProjectCtx): Promise<Step> {
    const out = await this.agent(task, ctx, 'architect', P.specPrompt(task), SpecOutput);
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
    const out = await this.agent(task, ctx, 'architect', P.impactPrompt(task, summarize(idx)), ImpactOutput);
    // Deterministic expansion: the model names files, the import graph finds their consumers.
    const dependentFiles = dependents(idx, out.filesToChange);
    const impact = { ...out, dependentFiles, affectedTests: affectedTests(idx, out.filesToChange) };
    const risky = isHighRisk(ctx.policy.project, out.filesToChange);
    const highRisk = risky.length > 0 || out.touchesDatabase || out.touchesAuth;
    if (highRisk && ctx.policy.project.approval.high_risk_changes === 'required' && !task.approvalsGranted.includes('high_risk')) {
      const why = [...risky.map((f) => `high-risk path: ${f}`), out.touchesDatabase ? 'database changes' : '', out.touchesAuth ? 'authentication/authorization changes' : ''].filter(Boolean);
      return {
        patch: { impact, approval: this.approval('high_risk', 'Plan contains high-risk changes', [...why, ...out.plan], 'IMPLEMENTATION') },
        to: 'AWAITING_APPROVAL',
      };
    }
    return { patch: { impact }, to: 'IMPLEMENTATION' };
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
    const out = await this.agent(task, ctx, 'reviewer', P.reviewerPrompt(task, diffText), ReviewOutput);
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
    if (pol.approval.before_pr === 'required' && !task.approvalsGranted.includes('before_pr')) {
      return { patch: { approval: this.approval('before_pr', 'Policy requires approval before opening a PR', ['Review the report and approve to open the PR'], 'DELIVERY') }, to: 'AWAITING_APPROVAL' };
    }
    const headCommit = await head(wt);
    const changes = await changedFiles(wt, task.baseCommit!);
    const runs = await store.listAgentRuns(task.id);
    const reportDir = join(this.d.dataDir, 'reports');
    mkdirSync(reportDir, { recursive: true });
    const reportPath = join(reportDir, `${task.id}.md`);
    const body = renderReport({ ...task, headCommit }, runs, changes);
    writeFileSync(reportPath, body);

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
      model: pol.agents.models[role] ?? pol.agents.model,
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
      effort: pol.agents.effort,
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
