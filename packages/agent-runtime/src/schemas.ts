import { z } from 'zod';

// Structured outputs for every role. These are *claims* from the model: the
// orchestrator stores them as notes and uses them to drive the next step,
// but never as evidence that something works.

const Severity = z.enum(['blocker', 'major', 'minor', 'info']);

export const DiscoveryOutput = z.object({
  summary: z.string().describe('How the relevant part of the system works today'),
  relevantFiles: z.array(z.string()).describe('Repo-relative paths that matter for this task'),
  existingPatterns: z.array(z.string()).describe('Conventions / existing implementations to reuse'),
  risks: z.array(z.string()),
  searchTerms: z
    .array(z.string())
    .describe('Identifiers and English domain words as they appear in this codebase (e.g. "booking", "cancelBooking", "reservations"), used for exhaustive code search'),
});

export const SpecOutput = z.object({
  title: z.string().describe('Short task title'),
  requirements: z
    .array(
      z.object({
        id: z.string().describe('REQ-01, REQ-02, ...'),
        description: z.string(),
        acceptanceCriteria: z.array(z.string()).describe('Concrete, testable criteria'),
      }),
    )
    .min(1),
  ambiguities: z.array(z.object({ question: z.string(), blocking: z.boolean() })),
  assumptions: z.array(z.string()),
});

export const ImpactOutput = z.object({
  summary: z.string(),
  filesToChange: z.array(z.string()),
  modules: z.array(z.string()),
  risks: z.array(z.string()),
  plan: z.array(z.string()).describe('Ordered implementation steps'),
  touchesDatabase: z.boolean(),
  touchesAuth: z.boolean(),
  touchesPublicApi: z.boolean(),
  subtasks: z
    .array(
      z.object({
        key: z.string().describe('Short id: S1, S2, …'),
        title: z.string(),
        description: z.string().describe('What exactly to implement in this part, self-contained'),
        requirementIds: z.array(z.string()),
        files: z.array(z.string()).describe('Files this part is expected to change'),
        dependsOn: z.array(z.string()).describe('Keys of subtasks that must be integrated first'),
      }),
    )
    .default([])
    .describe('Leave EMPTY unless the change is large and splits into parts that can be implemented and tested independently'),
});

export const DeveloperOutput = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()),
  notes: z.array(z.string()),
});

export const QaOutput = z.object({
  testFiles: z.array(z.string()),
  requirementTests: z.array(z.object({ requirementId: z.string(), testFiles: z.array(z.string()) })),
  notes: z.array(z.string()),
});

export const ReviewOutput = z.object({
  findings: z.array(
    z.object({
      severity: Severity,
      title: z.string(),
      description: z.string(),
      file: z.string().optional(),
      line: z.number().int().optional(),
      requirementId: z.string().optional(),
    }),
  ),
  unmetRequirements: z.array(z.string()).describe('IDs of requirements the code does not satisfy'),
});

export const IntegratorOutput = z.object({
  summary: z.string(),
  resolvedFiles: z.array(z.string()),
});

export const FixerOutput = z.object({
  summary: z.string(),
  defectsAddressed: z.array(z.string()).describe('Defect IDs you attempted to fix'),
});

export type DiscoveryOutput = z.infer<typeof DiscoveryOutput>;
export type SpecOutput = z.infer<typeof SpecOutput>;
export type ImpactOutput = z.infer<typeof ImpactOutput>;
export type DeveloperOutput = z.infer<typeof DeveloperOutput>;
export type QaOutput = z.infer<typeof QaOutput>;
export type ReviewOutput = z.infer<typeof ReviewOutput>;
export type FixerOutput = z.infer<typeof FixerOutput>;
export type IntegratorOutput = z.infer<typeof IntegratorOutput>;

/** JSON Schema for Claude Code structured output (without the `$schema` meta key it rejects). */
export function toOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
