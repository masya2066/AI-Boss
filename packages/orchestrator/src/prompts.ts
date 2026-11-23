import type { Defect, GateResult, Task } from '@devpilot/shared';

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

export function discoveryPrompt(task: Task, indexSummary: string): string {
  return `# Task ${task.id}: research only

## Request from the project owner
${task.prompt}

## Project index (deterministic, commit-bound)
${fence(indexSummary)}

Investigate how the codebase currently handles everything related to this request.
Follow imports and call sites; do not stop at the first matching file. Look for
existing implementations to reuse, related entities and consumers (notifications,
analytics, permissions, background jobs, tests). Do not modify anything.
Return the structured result.`;
}

export function specPrompt(task: Task): string {
  return `# Task ${task.id}: specification

## Request from the project owner
${task.prompt}
${humanBlock(task)}
## Research notes
${task.discovery?.summary ?? '(none)'}
Relevant files: ${task.discovery?.relevantFiles.join(', ') || '-'}
Existing patterns: ${task.discovery?.existingPatterns.join('; ') || '-'}
Risks: ${task.discovery?.risks.join('; ') || '-'}

Turn the request into numbered requirements (REQ-01, REQ-02, …) with concrete,
testable acceptance criteria, including negative cases and edge cases.
Only list an ambiguity as \`blocking: true\` if a wrong guess would make the
implementation unacceptable to the owner; otherwise record an assumption.
Do not modify any files.`;
}

export function impactPrompt(task: Task, indexSummary: string): string {
  return `# Task ${task.id}: impact analysis and plan

## Requirements
${requirementsBlock(task)}
${humanBlock(task)}
## Research notes
${task.discovery?.summary ?? '(none)'}

## Project index
${fence(indexSummary)}

Determine exactly which modules, files, API endpoints, DB tables/migrations,
UI components and tests are affected, including consumers of anything you change.
Produce an ordered implementation plan. Do not modify any files.`;
}

export function developerPrompt(task: Task): string {
  const impact = task.impact;
  return `# Task ${task.id}: implementation

You are working in an isolated git worktree on branch ${task.branch}. Implement the
requirements below completely. The orchestrator will run real checks afterwards
(typecheck, lint, tests, security, independent review) — do not claim success,
make it pass.

## Requirements
${requirementsBlock(task)}
${humanBlock(task)}
## Plan
${impact?.plan.map((s, i) => `${i + 1}. ${s}`).join('\n') ?? '(none)'}

Files expected to change: ${impact?.filesToChange.join(', ') || '-'}
Dependent files to keep working: ${impact?.dependentFiles.join(', ') || '-'}
Assumptions: ${task.assumptions.join('; ') || '-'}

Rules: follow existing conventions; do not touch CI config, policy files or secrets;
do not delete or skip existing tests; do not push or switch branches.
You may run the project's build/test commands to check your work.`;
}

export function qaPrompt(task: Task): string {
  return `# Task ${task.id}: tests for the requirements

The implementation for the requirements below is in the working tree. Write
automated tests that prove each acceptance criterion, including negative and
edge cases. You may only create or modify test files. If a requirement is not
actually implemented, write the test anyway — a failing test is the correct
outcome. Run the tests you wrote.

## Requirements
${requirementsBlock(task)}

Affected existing tests (keep them passing): ${task.impact?.affectedTests.join(', ') || '-'}

Return the mapping requirementId -> test files (repo-relative paths).`;
}

export function reviewerPrompt(task: Task, diffText: string): string {
  return `# Task ${task.id}: independent review

You are reviewing someone else's change. You are NOT given the author's reasoning —
judge only the code. Find real defects: requirement violations, logic errors,
missing edge cases, security issues (authz, injection, data exposure), broken
consumers, race conditions, missing migrations, tests that don't actually test
the criteria. Severity: blocker/major = must fix before merge; minor/info = advisory.
List requirement IDs that are not satisfied in \`unmetRequirements\`.

## Requirements
${requirementsBlock(task)}

## Results of deterministic checks (already executed by the system)
${gatesBlock(task.gates)}

## Files that depend on the changed code
${task.impact?.dependentFiles.join(', ') || '-'}

## Diff (base ${task.baseCommit?.slice(0, 8)} .. HEAD)
${fence(diffText)}

You may read any file in the repository for context. Do not modify anything.`;
}

export function fixerPrompt(task: Task, defects: Defect[]): string {
  return `# Task ${task.id}: repair attempt ${task.repairAttempts + 1}

The system ran real checks on the current code and found the defects below.
Fix the root causes in the code. Do not weaken, skip or delete tests and do not
change checks/configuration to make them pass — the integrity gate detects that.

## Open defects
${defects
  .map((d) => `### ${d.id} [${d.severity}] ${d.summary}${d.file ? `\n${d.file}${d.line ? ':' + d.line : ''}` : ''}\n${fence(d.details.slice(0, 6000))}`)
  .join('\n\n')}

## Requirements (for context)
${requirementsBlock(task)}
${humanBlock(task)}
After fixing, run the relevant checks yourself to confirm.`;
}
