import { createHash } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  newId,
  nowIso,
  tail,
  type Defect,
  type GateResult,
  type Requirement,
  type Severity,
  type Task,
} from '@devpilot/shared';
import { addedLines, changedFiles, head } from '@devpilot/git-manager';
import { matchesAny, planGates, type GatePlan, type ProjectPolicy } from '@devpilot/policy-engine';
import type { Executor } from '@devpilot/sandbox-manager';

/**
 * The only component allowed to produce gate and requirement statuses.
 * Everything here is derived from git state and real command exit codes.
 */

export function fingerprint(gate: string, output: string): string {
  const signal = output
    .split('\n')
    .filter((l) => /error|fail|✗|✖|assert|expected|exception|cannot|not found|TS\d+/i.test(l))
    .slice(0, 8)
    .map((l) =>
      l
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/\b[0-9a-f]{7,40}\b/gi, '<hash>')
        .replace(/\d+(\.\d+)?\s*(ms|s)\b/g, '<t>')
        .replace(/:\d+:\d+/g, ':<l>')
        .replace(/\d+/g, 'N')
        .replace(/(\/[^\s/:]+)+\//g, '<path>/')
        .trim(),
    )
    .join('\n');
  return createHash('sha1').update(`${gate}\n${signal || tail(output, 300)}`).digest('hex').slice(0, 16);
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/],
  ['github-token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['stripe-key', /\b(sk|rk)_live_[A-Za-z0-9]{20,}/],
  ['generic-secret', /\b(api[_-]?key|secret|passwd|password|auth[_-]?token)\b\s*[:=]\s*['"][^'"\s]{16,}['"]/i],
];

const FOCUS_OR_SKIP = /\b(describe|it|test|context)\.(only|skip)\s*\(|\bx(it|describe|test)\s*\(|\bfit\s*\(|\bfdescribe\s*\(|@Ignore\b|@Disabled\b|pytest\.mark\.skip|\bt\.Skip\(/;

export interface VerifyContext {
  task: Task;
  policy: ProjectPolicy;
  worktree: string;
  executor: Executor;
  artifactsDir: string;
}

export interface VerifyOutcome {
  head: string;
  gates: Record<string, GateResult>;
  requirements: Requirement[];
  /** New defects for failed gates (one per failing gate). */
  defects: Defect[];
  /** Required gates that could not be verified at all (needs a human). */
  notVerified: GateResult[];
  plan: GatePlan[];
}

function gate(name: string, commit: string, required: boolean, partial: Partial<GateResult>): GateResult {
  return { name, commit, required, status: 'pending', ranAt: nowIso(), ...partial };
}

export async function verify(ctx: VerifyContext): Promise<VerifyOutcome> {
  const { task, policy, worktree, executor } = ctx;
  const base = task.baseCommit!;
  const commit = await head(worktree);
  const changes = await changedFiles(worktree, base);
  const changedPaths = changes.map((c) => c.path);
  const plan = planGates(policy, changedPaths);
  const planned = new Map(plan.map((p) => [p.name, p]));
  const gates: Record<string, GateResult> = {};
  const timeoutMs = policy.limits.gate_timeout_seconds * 1000;
  const logDir = join(ctx.artifactsDir, task.id, 'gates', commit.slice(0, 12));

  const runCommandGate = async (name: string, command: string | undefined, required: boolean, reason: string, collect: string[] = []) => {
    if (!command) {
      gates[name] = gate(name, commit, required, {
        status: required ? 'not_verified' : 'skipped',
        reason: required ? `required but no command configured (commands.${name})` : reason,
      });
      return;
    }
    const logPath = join(logDir, `${name}.log`);
    const r = await executor.run(command, { cwd: worktree, timeoutMs, logPath });
    const output = `${r.stdout}\n${r.stderr}`;
    let status: GateResult['status'];
    let why = reason;
    if (r.infraError) {
      status = 'not_verified';
      why = `executor error: ${r.infraError}`;
    } else if (r.timedOut) {
      status = 'failed';
      why = `timed out after ${policy.limits.gate_timeout_seconds}s`;
    } else status = r.exitCode === 0 ? 'passed' : 'failed';
    gates[name] = gate(name, commit, required, {
      status,
      command,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      outputTail: tail(output, 4000),
      logPath,
      reason: `${why} [${executor.kind}]`,
      artifacts: collectArtifacts(name, collect),
    });
  };
  const collectArtifacts = (name: string, items: string[]) => {
    const saved: string[] = [];
    for (const item of items) {
      const src = join(worktree, item);
      if (!existsSync(src)) continue;
      const dst = join(logDir, `${name}-artifacts`, item);
      cpSync(src, dst, { recursive: true });
      saved.push(dst);
    }
    return saved.length ? saved : undefined;
  };

  // --- built-in: diff_present -------------------------------------------------
  const dp = planned.get('diff_present');
  if (dp && dp.required) {
    gates.diff_present = gate('diff_present', commit, true, {
      status: changes.length > 0 ? 'passed' : 'failed',
      reason: changes.length > 0 ? `${changes.length} files changed` : 'no changes relative to base commit',
    });
  }

  // --- built-in: test_integrity ---------------------------------------------
  const ti = planned.get('test_integrity');
  if (ti && ti.required) {
    const problems: string[] = [];
    for (const c of changes) {
      if (c.status === 'D' && matchesAny(c.path, policy.paths.tests)) problems.push(`deleted test file ${c.path}`);
      if (matchesAny(c.path, policy.paths.protected)) problems.push(`modified protected file ${c.path}`);
    }
    const added = await addedLines(worktree, base);
    for (const a of added) {
      if (matchesAny(a.file, policy.paths.tests) && FOCUS_OR_SKIP.test(a.line))
        problems.push(`${a.file}: focused/skipped test added: ${a.line.trim().slice(0, 120)}`);
    }
    gates.test_integrity = gate('test_integrity', commit, true, {
      status: problems.length ? 'failed' : 'passed',
      outputTail: problems.join('\n'),
      reason: problems.length ? `${problems.length} integrity problems` : 'no tampering detected',
    });
  }

  // --- built-in: secrets_scan ------------------------------------------------
  const ss = planned.get('secrets_scan');
  if (ss && ss.required) {
    const added = await addedLines(worktree, base);
    const hits = added.flatMap((a) =>
      SECRET_PATTERNS.filter(([, rx]) => rx.test(a.line)).map(([kind]) => `${a.file}: ${kind}`),
    );
    gates.secrets_scan = gate('secrets_scan', commit, true, {
      status: hits.length ? 'failed' : 'passed',
      outputTail: hits.join('\n'),
      reason: hits.length ? `${hits.length} potential secrets in added lines` : 'no secrets in diff',
    });
  }

  // --- command gates (setup first) ----------------------------------------------
  let setupFailed = false;
  if (policy.commands.setup) {
    await runCommandGate('setup', policy.commands.setup, true, 'environment setup');
    setupFailed = gates.setup!.status !== 'passed';
  }
  for (const p of plan) {
    if (['diff_present', 'test_integrity', 'secrets_scan', 'requirements_coverage', 'independent_review'].includes(p.name)) continue;
    if (!p.required) {
      gates[p.name] = gate(p.name, commit, false, { status: 'skipped', reason: p.reason });
      continue;
    }
    if (setupFailed) {
      gates[p.name] = gate(p.name, commit, true, { status: 'not_verified', reason: 'setup gate failed' });
      continue;
    }
    await runCommandGate(p.name, p.command, true, p.reason, p.collect);
  }

  // --- built-in: requirements_coverage --------------------------------------------
  const requirements = task.requirements.map((r) => ({ ...r }));
  const rc = planned.get('requirements_coverage');
  if (rc && rc.required) {
    const unitOk = gates.unit_tests?.status === 'passed';
    const lines: string[] = [];
    for (const r of requirements) {
      // A requirement with no behaviour (formatting, docs, config) may be proved by a deterministic
      // gate instead of a test: "gate:lint". Only non-behavioural gates qualify, the gate must be
      // required and have passed on this very commit, and the reviewer is told to reject the claim
      // if the diff changes behaviour.
      const gateRefs = r.tests.filter((t) => t.startsWith('gate:'));
      if (gateRefs.length && gateRefs.length === r.tests.length) {
        const bad = gateRefs.filter((t) => {
          const g = gates[t.slice(5)];
          return !NO_BEHAVIOUR_GATES.includes(t.slice(5)) || !g?.required || g.status !== 'passed';
        });
        r.status = bad.length ? 'failed' : 'verified';
        lines.push(
          bad.length
            ? `${r.id}: ${bad.join(', ')} cannot prove it (allowed: ${NO_BEHAVIOUR_GATES.map((x) => 'gate:' + x).join(', ')}; must be required and passed)`
            : `${r.id}: no behaviour change, proved by ${gateRefs.join(', ')}`,
        );
        continue;
      }
      const existing = r.tests.filter((t) => !t.startsWith('gate:') && existsSync(join(worktree, t)));
      if (existing.length === 0) {
        r.status = 'failed';
        lines.push(`${r.id}: no existing test mapped (${r.tests.join(', ') || 'none'})`);
        continue;
      }
      if (policy.commands.requirement_tests) {
        const cmd = policy.commands.requirement_tests.replace('{files}', existing.map((f) => JSON.stringify(f)).join(' '));
        const res = await executor.run(cmd, { cwd: worktree, timeoutMs, logPath: join(logDir, `req-${r.id}.log`) });
        r.status = res.exitCode === 0 && !res.timedOut ? 'verified' : 'failed';
        lines.push(`${r.id}: ${r.status} (${existing.join(', ')})`);
      } else {
        r.status = unitOk ? 'covered' : 'failed';
        lines.push(`${r.id}: ${r.status} via ${existing.join(', ')}`);
      }
    }
    const allOk = requirements.length > 0 && requirements.every((r) => r.status === 'verified' || r.status === 'covered');
    gates.requirements_coverage = gate('requirements_coverage', commit, true, {
      status: requirements.length === 0 ? 'not_verified' : allOk ? 'passed' : 'failed',
      outputTail: lines.join('\n'),
      reason: requirements.length === 0 ? 'no requirements recorded' : allOk ? 'all requirements mapped to passing tests' : 'uncovered requirements',
    });
  }

  // --- independent_review: a PASSED review is carried over only for this very commit -----
  // A failed one is never carried: after a repair attempt that changed nothing (e.g. the
  // fixer declared a finding out of scope) the reviewer must look again, otherwise the
  // stale verdict loops REPAIR -> VALIDATION -> REPAIR without anyone re-judging.
  const ir = planned.get('independent_review');
  if (ir && ir.required) {
    const prev = task.gates.independent_review;
    gates.independent_review =
      prev && prev.commit === commit && prev.status === 'passed'
        ? prev
        : gate('independent_review', commit, true, { status: 'pending', reason: prev?.commit === commit ? 'previous review failed: re-review' : 'review not yet run for this commit' });
  }

  const defects: Defect[] = Object.values(gates)
    .filter((g) => g.required && g.status === 'failed')
    .map((g) => ({
      id: newId('DEF'),
      source: 'gate' as const,
      gate: g.name,
      severity: 'blocker' as Severity,
      fingerprint: fingerprint(g.name, g.outputTail ?? ''),
      summary: `${g.name} failed${g.reason ? `: ${g.reason}` : ''}`,
      details: `command: ${g.command ?? '(built-in)'}\nexit: ${g.exitCode ?? '-'}\nlog: ${g.logPath ?? '-'}\n\n${g.outputTail ?? ''}`,
      foundInAttempt: task.repairAttempts,
      resolved: false,
    }));

  const notVerified = Object.values(gates).filter(
    (g) => g.required && g.status === 'not_verified' && g.reason !== 'setup gate failed' && g.name !== 'requirements_coverage',
  );
  return { head: commit, gates, requirements, defects, notVerified, plan };
}

/** Gates that can prove a requirement with no behaviour (they check form, not behaviour). */
export const NO_BEHAVIOUR_GATES = ['lint', 'typecheck', 'build'];

export interface ReviewFinding {
  severity: Severity;
  title: string;
  description: string;
  file?: string;
  line?: number;
  requirementId?: string;
}

/** Turns reviewer output into a gate result. Blocker/major findings fail the gate. */
export function recordReview(task: Task, commit: string, findings: ReviewFinding[], uncoveredRequirements: string[]) {
  const blocking = findings.filter((f) => f.severity === 'blocker' || f.severity === 'major');
  const unknownReqs = uncoveredRequirements.filter((id) => task.requirements.some((r) => r.id === id));
  const failed = blocking.length > 0 || unknownReqs.length > 0;
  const g: GateResult = {
    name: 'independent_review',
    commit,
    required: true,
    status: failed ? 'failed' : 'passed',
    ranAt: nowIso(),
    reason: failed
      ? `${blocking.length} blocking findings, ${unknownReqs.length} requirements reported unmet`
      : `${findings.length} non-blocking findings`,
    outputTail: findings.map((f) => `[${f.severity}] ${f.file ?? ''}${f.line ? ':' + f.line : ''} ${f.title}`).join('\n'),
  };
  const defects: Defect[] = [
    ...blocking.map((f) => ({
      id: newId('DEF'),
      source: 'review' as const,
      gate: 'independent_review',
      severity: f.severity,
      fingerprint: createHash('sha1').update(`review\n${f.file ?? ''}\n${f.title.toLowerCase()}`).digest('hex').slice(0, 16),
      summary: f.title,
      details: f.description,
      file: f.file,
      line: f.line,
      requirementId: f.requirementId,
      foundInAttempt: task.repairAttempts,
      resolved: false,
    })),
    ...unknownReqs.map((id) => ({
      id: newId('DEF'),
      source: 'review' as const,
      gate: 'independent_review',
      severity: 'major' as Severity,
      fingerprint: createHash('sha1').update(`review-req\n${id}`).digest('hex').slice(0, 16),
      summary: `Requirement ${id} is not satisfied by the implementation`,
      details: task.requirements.find((r) => r.id === id)?.description ?? id,
      requirementId: id,
      foundInAttempt: task.repairAttempts,
      resolved: false,
    })),
  ];
  return { gate: g, defects };
}
