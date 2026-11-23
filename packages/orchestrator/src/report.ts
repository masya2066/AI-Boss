import type { AgentRun, Task } from '@devpilot/shared';
import type { FileChange } from '@devpilot/git-manager';

const icon: Record<string, string> = {
  passed: '✅',
  failed: '❌',
  not_verified: '⚠️',
  skipped: '➖',
  pending: '⏳',
};

/** Evidence-based delivery report: every status here comes from the verification engine. */
export function renderReport(task: Task, runs: AgentRun[], changes: FileChange[]): string {
  const gates = Object.values(task.gates);
  const required = gates.filter((g) => g.required);
  const passed = required.filter((g) => g.status === 'passed' && g.commit === task.headCommit);
  const fixed = task.defects.filter((d) => d.resolved).length;
  const open = task.defects.filter((d) => !d.resolved);
  const lines: string[] = [];
  lines.push(`# ${task.id}: ${task.title}`);
  lines.push('');
  lines.push(`**Status:** ${task.state === 'DONE' || task.state === 'DELIVERY' ? 'Ready for review' : task.state}  `);
  lines.push(`**Branch:** \`${task.branch}\` · **Base:** \`${task.baseCommit?.slice(0, 10)}\` · **Head:** \`${task.headCommit?.slice(0, 10)}\`  `);
  lines.push(`**Checks:** ${passed.length}/${required.length} required passed at HEAD · **Defects fixed:** ${fixed} · **Repair attempts:** ${task.repairAttempts} · **Cost:** $${task.costUsd.toFixed(2)}`);
  lines.push('');
  lines.push('## Requirements');
  for (const r of task.requirements) {
    lines.push(`- **${r.id}** (${r.status}) ${r.description}`);
    for (const c of r.acceptanceCriteria) lines.push(`  - ${c}`);
    if (r.tests.length) lines.push(`  - tests: ${r.tests.map((t) => `\`${t}\``).join(', ')}`);
  }
  if (task.assumptions.length) {
    lines.push('', '## Assumptions');
    for (const a of task.assumptions) lines.push(`- ${a}`);
  }
  lines.push('', '## Quality gates (evaluated by DevPilot, not by the agent)');
  lines.push('| Gate | Required | Status | Commit | Duration | Note |', '|---|---|---|---|---|---|');
  for (const g of gates) {
    lines.push(
      `| ${g.name} | ${g.required ? 'yes' : 'no'} | ${icon[g.status] ?? ''} ${g.status} | \`${g.commit.slice(0, 8)}\` | ${g.durationMs != null ? `${(g.durationMs / 1000).toFixed(1)}s` : '-'} | ${(g.reason ?? '').replace(/\|/g, '/')} |`,
    );
  }
  const evidence = gates.filter((g) => g.artifacts?.length || g.logPath);
  if (evidence.length) {
    lines.push('', '## Evidence');
    for (const g of evidence) lines.push(`- **${g.name}**: ${[g.logPath, ...(g.artifacts ?? [])].filter(Boolean).map((p) => `\`${p}\``).join(', ')}`);
  }
  if (task.impact) {
    lines.push('', '## Impact analysis');
    lines.push(task.impact.summary);
    if (task.impact.dependentFiles.length) lines.push(`- Dependent files (import graph): ${task.impact.dependentFiles.map((f) => `\`${f}\``).join(', ')}`);
    if (task.impact.risks.length) lines.push(`- Risks: ${task.impact.risks.join('; ')}`);
  }
  lines.push('', '## Changed files');
  for (const c of changes) lines.push(`- \`${c.status}\` ${c.path}`);
  if (task.defects.length) {
    lines.push('', '## Defect history');
    for (const d of task.defects) lines.push(`- ${d.resolved ? '✔︎' : '✘'} [${d.source}/${d.severity}] attempt ${d.foundInAttempt}: ${d.summary}`);
  }
  if (open.length) {
    lines.push('', '## Remaining limitations');
    for (const d of open) lines.push(`- [${d.severity}] ${d.summary}`);
  }
  lines.push('', '## Agent runs');
  lines.push('| Role | State | Result | Turns | Tool calls | Denied | Cost |', '|---|---|---|---|---|---|---|');
  for (const r of runs) {
    lines.push(`| ${r.role} | ${r.state} | ${r.subtype ?? r.status} | ${r.numTurns} | ${r.toolCalls} | ${r.deniedToolCalls.length} | $${r.costUsd.toFixed(2)} |`);
  }
  lines.push('', '> Merge is never automatic. Merge only after CI passes on this PR.');
  return lines.join('\n');
}
