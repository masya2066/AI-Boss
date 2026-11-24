import type { Defect, GateResult, Subtask, Task } from '@devpilot/shared';

// Prompts are assembled from durable task memory (DB), never from a previous
// agent's conversation. Each agent starts with exactly the facts it needs.

const fence = (s: string) => '```\n' + s + '\n```';

function requirementsBlock(task: Task): string {
  if (!task.requirements.length) return '(none yet)';
  return task.requirements
    .map((r) => `- ${r.id}: ${r.description}\n${r.acceptanceCriteria.map((c) => `    - [ ] ${c}`).join('\n')}${r.tests.length ? `\n    tests: ${r.tests.join(', ')}` : ''}`)
    .join('\n');
}

function humanBlock(task: Task): string {
  if (!task.humanInput.length) return '';
  return `\n## Decisions from the project owner\n${task.humanInput.map((h) => `- (${h.kind}) ${h.text}`).join('\n')}\n`;
}

function gatesBlock(gates: Record<string, GateResult>): string {
  const rows = Object.values(gates).map((g) => `- ${g.name}: ${g.status.toUpperCase()}${g.required ? '' : ' (optional)'}${g.reason ? ` — ${g.reason}` : ''}`);
  return rows.join('\n') || '(no gates evaluated)';
}

export function discoveryPrompt(task: Task, indexSummary: string, prelim: string): string {
  return `# Task ${task.id}: research only

## Request from the project owner
${task.prompt}

## Architecture map (deterministic index, commit-bound)
${fence(indexSummary)}
${prelim ? `\n## Preliminary concept-search hits (lexical, may be incomplete)\n${fence(prelim)}\n` : ''}
In \`searchTerms\` list the identifiers and English domain words this codebase uses for
the concepts in the request (the request may be in another language). The system uses
them to search the whole repository exhaustively.

Investigate how the codebase currently handles everything related to this request.
Follow imports and call sites; do not stop at the first matching file. Look for
existing implementations to reuse, related entities and consumers (notifications,
analytics, permissions, background jobs, tests). Do not modify anything.
Return the structured result.`;
}

function contextBlock(task: Task): string {
  return task.discovery?.context ? `\n## Related code found by the system (import graph, shared tables, tests)\n${fence(task.discovery.context)}\n` : '';
}

function memoryBlock(memory: string): string {
  return memory ? `\n## Previously delivered related features (rules already in force — do not break them)\n${memory}\n` : '';
}

export function specPrompt(task: Task, memory = ''): string {
  return `# Task ${task.id}: specification

## Request from the project owner
${task.prompt}
${humanBlock(task)}
## Research notes
${task.discovery?.summary ?? '(none)'}
Relevant files: ${task.discovery?.relevantFiles.join(', ') || '-'}
Existing patterns: ${task.discovery?.existingPatterns.join('; ') || '-'}
Risks: ${task.discovery?.risks.join('; ') || '-'}
${contextBlock(task)}${memoryBlock(memory)}

Turn the request into numbered requirements (REQ-01, REQ-02, …) with concrete,
testable acceptance criteria, including negative cases and edge cases.
Only list an ambiguity as \`blocking: true\` if a wrong guess would make the
implementation unacceptable to the owner; otherwise record an assumption.
For every ambiguity give \`proposedDefault\`: the answer you would pick if nobody answers, and why.
Do not modify any files.`;
}

export function impactPrompt(task: Task, indexSummary: string, memory = ''): string {
  return `# Task ${task.id}: impact analysis and plan

## Requirements
${requirementsBlock(task)}
${humanBlock(task)}
## Research notes
${task.discovery?.summary ?? '(none)'}
${contextBlock(task)}${memoryBlock(memory)}
## Project index
${fence(indexSummary)}

Determine exactly which modules, files, API endpoints, DB tables/migrations,
UI components and tests are affected, including consumers of anything you change.
Produce an ordered implementation plan. Do not modify any files.
${task.parentId ? 'This is already a subtask: return an empty `subtasks` list.' : SPLIT_RULES}`;
}

const SPLIT_RULES = `## Splitting into subtasks
Separate agents will implement subtasks in parallel, each in its own branch, then the
system merges them and re-verifies the whole. Split when the change spans areas that
can be built and tested on their own — e.g. backend endpoint + UI screen, a new
module + its integration points, several independent features in one request, or
data-model change + the code that uses it (as a dependency). Typical signals:
6+ files in 2+ modules, or 3+ requirements that touch different code.
Do NOT split a small or tightly coupled change (one function, one bugfix, a rename).

Rules for \`subtasks\` (2–8 parts, otherwise an empty list):
- every requirement belongs to at least one subtask (\`requirementIds\`); a requirement may be
  shared by several parts — then each part's \`description\` states exactly which share it delivers;
- \`description\` is self-contained: the agent sees only it, the requirements and the plan;
- \`dependsOn\` when a part needs another part's code (shared types, schema, API contract);
- \`files\`: the files each part changes, honestly — parts sharing files run one after another.`;

export function splitPrompt(task: Task, score: number, indexSummary: string): string {
  const impact = task.impact;
  return `# Task ${task.id}: can this plan be split?

The plan below changes ${impact?.filesToChange.length ?? 0} files and scored ${score} on the system's
complexity scale, but no subtasks were proposed. Take a second, deliberate look.

## Requirements
${requirementsBlock(task)}
## Plan
${impact?.plan.map((s, i) => `${i + 1}. ${s}`).join('\n') ?? '(none)'}

Files to change: ${impact?.filesToChange.join(', ') || '-'}
Modules: ${impact?.modules.join(', ') || '-'}

## Project index
${fence(indexSummary)}

${SPLIT_RULES}

If it genuinely cannot be split, return an empty list and say why in \`reason\`.
Do not modify any files.`;
}

export function soloPrompt(task: Task, checks: { name: string; command?: string }[]): string {
  return `# Task ${task.id}

You are working in an isolated git worktree on branch ${task.branch}. Implement the request
below completely, in this one session, the way a careful senior engineer would:
- read the code you need and follow its conventions;
- write automated tests for every behaviour you add or change — positive, negative and edge
  cases — in the project's existing test style, where the test command finds them;
- run the checks below yourself and make them pass before you finish.

Afterwards the system re-runs every check itself and an independent reviewer compares your diff
with the request. Do not claim success — make it true.
Rules: do not touch CI config, policy files or secrets; do not delete, skip or weaken existing
tests; do not push or switch branches.

## Request
${task.prompt}
${humanBlock(task)}
## Checks the system will run
${checks.map((c) => `- ${c.name}: ${c.command ? `\`${c.command}\`` : '(built-in)'}`).join('\n')}

When done, return the requirements you implemented (REQ-01, REQ-02, …): every behaviour the
request asks for, each with its acceptance criteria and the test files that prove it.`;
}

export function developerPrompt(task: Task): string {
  const impact = task.impact;
  return `# Task ${task.id}: implementation

You are working in an isolated git worktree on branch ${task.branch}. Implement the
requirements below completely. The orchestrator will run real checks afterwards
(typecheck, lint, tests, security, independent review) — do not claim success,
make it pass.

## Task
${task.prompt}

## Requirements
${requirementsBlock(task)}
${humanBlock(task)}
## Plan
${impact?.plan.map((s, i) => `${i + 1}. ${s}`).join('\n') ?? '(none)'}

Files expected to change: ${impact?.filesToChange.join(', ') || '-'}
Dependent files to keep working: ${impact?.dependentFiles.join(', ') || '-'}
Other code using the same data: ${impact?.relatedData?.join('; ') || '-'}
Assumptions: ${task.assumptions.join('; ') || '-'}

Rules: follow existing conventions; do not touch CI config, policy files or secrets;
do not delete or skip existing tests; do not push or switch branches.
You may run the project's build/test commands to check your work.`;
}

export function qaPrompt(task: Task, testCmd?: string): string {
  return `# Task ${task.id}: tests for the requirements

The implementation for the requirements below is in the working tree. Write
automated tests that prove each acceptance criterion, including negative and
edge cases. You may only create or modify test files. If a requirement is not
actually implemented, write the test anyway — a failing test is the correct
outcome. Run the tests you wrote.
${testCmd ? `\nThe project's tests are run with \`${testCmd}\` — put the tests where that command finds them, in the\nproject's existing test style and framework.` : ''}

## Task
${task.prompt}

## Requirements
${requirementsBlock(task)}

Affected existing tests (keep them passing): ${task.impact?.affectedTests.join(', ') || '-'}

Return the mapping requirementId -> test files (repo-relative paths).`;
}

/** A subtask is judged and repaired against its own share of shared requirements. */
function scopeBlock(task: Task, role: 'review' | 'fix'): string {
  if (!task.parentId) return '';
  return `
## Scope: subtask ${task.subtaskKey ?? ''} of ${task.parentId}
${task.prompt}

The requirements below are shared with the other parts of the parent task, which are
implemented in separate branches and merged later; the integrated result is verified
and reviewed again as a whole. ${
    role === 'review'
      ? `Judge only the behaviour THIS part is responsible for. Do not report missing
behaviour that belongs to another part, and list a requirement in \`unmetRequirements\`
only if this part's share of it is missing or wrong.`
      : `Fix only what this part is responsible for. If a defect asks for behaviour that
belongs to another part, do not implement it here (that would collide with that part's
branch): say so in your summary and leave it.`
  }
`;
}

/**
 * Severity decides whether the change goes back for a (paid) repair. Measured: an uncalibrated
 * reviewer blocks on wishes outside the request (e.g. "emails should use the app clock"),
 * which doubles a task's cost without changing whether it does what was asked.
 */
const REVIEW_CALIBRATION = `
Severity rules — they decide whether the change goes back for another (paid) repair round:
- blocker/major ONLY for: something the request asks for that is missing or wrong; a bug that
  breaks requested behaviour; a security problem (authz, injection, data exposure, secrets);
  data loss or corruption; broken existing behaviour or a broken consumer of changed code;
  tests that claim to prove a requirement but do not.
- Everything else is minor/info (advisory, no repair): hardening beyond the request, style,
  naming, refactoring, performance without a concrete problem, behaviour the request does not
  mention, pre-existing code the change did not touch.
- Put a requirement in \`unmetRequirements\` only if the code really fails it.
Be efficient: the system already ran the checks below — do not re-run the test suite. Read only
the files you need to judge the diff.
`;

export function reviewerPrompt(task: Task, diffText: string, blastRadius = '', o: { calibrated?: boolean } = {}): string {
  return `# Task ${task.id}: independent review

You are reviewing someone else's change. You are NOT given the author's reasoning —
judge only the code. Find real defects: requirement violations, logic errors,
missing edge cases, security issues (authz, injection, data exposure), broken
consumers, race conditions, missing migrations, tests that don't actually test
the criteria. Severity: blocker/major = must fix before merge; minor/info = advisory.
List requirement IDs that are not satisfied in \`unmetRequirements\`.
${o.calibrated === false ? '' : REVIEW_CALIBRATION}
${scopeBlock(task, 'review')}${
    task.parentId
      ? ''
      : `
## Original request (the requirements below were derived from it — check the diff against BOTH;
anything the request asks for that is missing or wrong is a blocker)
${task.prompt}
`
  }
## Requirements
${requirementsBlock(task)}

## Results of deterministic checks (already executed by the system)
${gatesBlock(task.gates)}

## Blast radius computed by the system (symbol-level)
${blastRadius || '(no exported symbols with external consumers changed)'}
Check every consumer marked NOT changed: does it still work with the new behaviour?

## Diff (base ${task.baseCommit?.slice(0, 8)} .. HEAD)
${fence(diffText)}

You may read any file in the repository for context. Do not modify anything.`;
}

export function fixerPrompt(task: Task, defects: Defect[]): string {
  return `# Task ${task.id}: repair attempt ${task.repairAttempts + 1}

The system ran real checks on the current code and found the defects below.
Fix the root causes in the code. Do not weaken, skip or delete tests and do not
change checks/configuration to make them pass — the integrity gate detects that.
${scopeBlock(task, 'fix')}
## Open defects
${defects
  .map((d) => `### ${d.id} [${d.severity}] ${d.summary}${d.file ? `\n${d.file}${d.line ? ':' + d.line : ''}` : ''}\n${fence(d.details.slice(0, 6000))}`)
  .join('\n\n')}

## Requirements (for context)
${requirementsBlock(task)}
${humanBlock(task)}${
    defects.some((d) => /requirements_coverage/.test(d.summary))
      ? `
Requirements coverage failed: write the missing tests (or find the existing tests that already
prove the requirement) and return every requirement -> test files pair in \`requirementTests\`.
`
      : ''
  }
After fixing, run the relevant checks yourself to confirm.`;
}

export function integratorPrompt(parent: Task, s: Subtask, child: Task, conflicts: string[], integrated: string[]): string {
  return `# Task ${parent.id}: resolve merge conflicts while integrating subtask ${s.key}

Integration branch: ${parent.branch} (already contains: ${integrated.join('; ') || 'nothing yet'})
Merging: ${child.branch} — ${s.key}: ${s.title}
${s.description}

## Conflicted files
${conflicts.map((f) => `- ${f}`).join('\n')}

## Requirements of the whole feature (all must hold after the merge)
${requirementsBlock(parent)}

Resolve every conflict so that the code satisfies both the already integrated parts and ${s.key}.
Remove all conflict markers. Do not commit — the system commits and re-verifies everything.`;
}
