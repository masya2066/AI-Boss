import { tokenize } from './search';

// Long-term Project Knowledge: what was delivered, which rules are in force,
// which code and tests implement them. Built from finished tasks (facts the
// system verified), not from model recollection.

export interface FeatureEntry {
  taskId: string;
  title: string;
  prompt: string;
  completedAt: string;
  commit: string;
  prUrl?: string;
  requirements: { id: string; description: string; acceptanceCriteria: string[] }[];
  assumptions: string[];
  decisions: string[];
  files: string[];
  tests: string[];
  endpoints: string[];
  tables: string[];
  terms: string[];
}

export interface ProjectKnowledge {
  projectId: string;
  updatedAt: string;
  features: FeatureEntry[];
  notes: { text: string; source: string; at: string }[];
}

export const emptyKnowledge = (projectId: string): ProjectKnowledge => ({ projectId, updatedAt: new Date().toISOString(), features: [], notes: [] });

export function recordFeature(k: ProjectKnowledge | undefined, projectId: string, entry: FeatureEntry): ProjectKnowledge {
  const base = k ?? emptyKnowledge(projectId);
  const terms = entry.terms.length ? entry.terms : [...new Set(tokenize([entry.title, entry.prompt, ...entry.requirements.map((r) => r.description)].join(' ')))];
  return {
    ...base,
    updatedAt: new Date().toISOString(),
    features: [...base.features.filter((f) => f.taskId !== entry.taskId), { ...entry, terms }],
  };
}

/** Features related to the current work by shared files (strong) or shared concepts. */
export function relevantKnowledge(k: ProjectKnowledge | undefined, o: { terms: string[]; files: string[] }, limit = 5): FeatureEntry[] {
  if (!k) return [];
  const terms = new Set(o.terms.flatMap(tokenize));
  const files = new Set(o.files);
  return k.features
    .map((f) => ({ f, s: 3 * f.files.filter((x) => files.has(x)).length + f.terms.filter((t) => terms.has(t)).length }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.f.completedAt.localeCompare(a.f.completedAt))
    .slice(0, limit)
    .map((x) => x.f);
}

export function featureMemory(entries: FeatureEntry[]): string {
  if (!entries.length) return '';
  return entries
    .map((f) =>
      [
        `### ${f.taskId}: ${f.title} (delivered ${f.completedAt.slice(0, 10)}, ${f.commit.slice(0, 8)}${f.prUrl ? `, ${f.prUrl}` : ''})`,
        ...f.requirements.map((r) => `- ${r.id}: ${r.description}${r.acceptanceCriteria.length ? ` [${r.acceptanceCriteria.join('; ')}]` : ''}`),
        ...(f.decisions.length ? [`- Owner decisions: ${f.decisions.join('; ')}`] : []),
        `- Code: ${f.files.slice(0, 12).join(', ')}${f.tests.length ? ` · tests: ${f.tests.slice(0, 8).join(', ')}` : ''}`,
      ].join('\n'),
    )
    .join('\n\n');
}
