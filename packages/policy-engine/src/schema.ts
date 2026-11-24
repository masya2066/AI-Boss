import { z } from 'zod';

const GateMode = z.enum(['required', 'conditional', 'off']);

const GateRule = z.union([
  GateMode,
  z.object({
    mode: GateMode,
    /** For `conditional`: the gate becomes required when any changed file matches. */
    when: z.object({ paths: z.array(z.string()).default([]) }).optional(),
    /** Files/dirs (relative to the worktree) to keep as evidence after the gate, e.g. playwright-report. */
    collect: z.array(z.string()).default([]),
  }),
]);
export type GateRule = z.infer<typeof GateRule>;

const RoleName = z.enum(['researcher', 'architect', 'developer', 'qa', 'reviewer', 'fixer', 'integrator']);

export const ProjectPolicySchema = z.object({
  project: z
    .object({ id: z.string().optional(), default_branch: z.string().default('main') })
    .prefault({}),
  execution: z
    .object({
      isolated_worktree: z.literal(true).default(true),
      /** Run gate commands inside a throwaway container instead of on the host. */
      containerized: z.boolean().default(false),
      container_image: z.string().default('node:24-bookworm'),
      /** Network for gate containers. `none` is the safe default. */
      container_network: z.enum(['none', 'bridge']).default('none'),
      container_cpus: z.string().default('2'),
      container_memory: z.string().default('4g'),
      /** Enable Claude Code's own OS-level sandbox for agent Bash commands. */
      agent_sandbox: z.boolean().default(true),
      max_parallel_agents: z.number().int().positive().default(2),
      /**
       * solo (default): one developer session does the whole change (code + tests); DevPilot runs
       * every gate itself, one independent review, and repairs by resuming that same session.
       * Measured: same quality as a plain Claude Code session at a fraction of the pipeline's cost.
       * pipeline: researcher -> spec -> impact -> (subtasks) -> developer -> QA -> review.
       */
      mode: z.enum(['solo', 'pipeline']).default('solo'),
      /** Env vars passed through to agents/gates. Everything else is scrubbed. */
      env_passthrough: z.array(z.string()).default([]),
    })
    .prefault({}),
  limits: z
    .object({
      max_repair_attempts: z.number().int().nonnegative().default(5),
      /** Stop when the same failure fingerprint shows up this many times. */
      max_same_failure: z.number().int().positive().default(3),
      /** Stop after N repair attempts in a row without reducing open defects. */
      max_no_progress_attempts: z.number().int().positive().default(3),
      max_task_cost_usd: z.number().positive().default(20),
      /** Project-wide spend per calendar day; when reached, tasks pause until midnight. */
      max_daily_cost_usd: z.number().positive().optional(),
      max_duration_minutes: z.number().positive().default(90),
      gate_timeout_seconds: z.number().positive().default(900),
    })
    .prefault({}),
  agents: z
    .object({
      model: z.string().default('claude-opus-5-5'),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
      models: z.partialRecord(RoleName, z.string()).default({}),
      /** Per-role effort override (e.g. a cheaper, faster reviewer). */
      efforts: z.partialRecord(RoleName, z.enum(['low', 'medium', 'high', 'xhigh', 'max'])).default({}),
      max_turns: z.partialRecord(RoleName, z.number().int().positive()).default({}),
      allow_web: z.boolean().default(false),
      /**
       * Model/effort by task complexity (deterministic score after impact analysis).
       * Off by default: DevPilot never picks a cheaper model unless you configure it.
       */
      routing: z
        .object({
          enabled: z.boolean().default(false),
          tiers: z
            .array(z.object({ name: z.string(), max_score: z.number().optional(), model: z.string(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']) }))
            .default([
              { name: 'small', max_score: 4, model: 'claude-sonnet-5-5', effort: 'medium' },
              { name: 'medium', max_score: 10, model: 'claude-opus-5-5', effort: 'high' },
              { name: 'large', model: 'claude-opus-5-5', effort: 'xhigh' },
            ]),
          /** Roles that always use the top tier (judgement-heavy). */
          top_tier_roles: z.array(z.string()).default(['architect', 'reviewer']),
          /** Move the fixer one tier up after this many repair attempts. */
          escalate_fixer_after: z.number().int().nonnegative().default(2),
        })
        .prefault({}),
      /**
       * subscription: run the official `claude` CLI headless (`claude -p`) with your
       *   Claude Pro/Max login (or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`).
       *   ANTHROPIC_API_KEY is stripped so it can never silently take precedence.
       * api: Claude Agent SDK with ANTHROPIC_API_KEY (pay-as-you-go).
       */
      auth: z.enum(['subscription', 'api']).default('subscription'),
      /** On a subscription usage-limit hit: pause the task until the window resets (true) or block it (false). */
      wait_on_rate_limit: z.boolean().default(true),
    })
    .prefault({}),
  /** Shell commands for command-backed gates. A required gate without a command is NOT_VERIFIED. */
  commands: z
    .object({
      setup: z.string().optional(),
      typecheck: z.string().optional(),
      lint: z.string().optional(),
      build: z.string().optional(),
      unit_tests: z.string().optional(),
      integration_tests: z.string().optional(),
      e2e_tests: z.string().optional(),
      security_scan: z.string().optional(),
      /** Optional per-requirement test command. `{files}` is replaced with the mapped test files. */
      requirement_tests: z.string().optional(),
    })
    .prefault({}),
  quality: z.record(z.string(), GateRule).default({}),
  /** gate -> why it is configured this way (written by project detection; shown as the gate reason). */
  notes: z.record(z.string(), z.string()).default({}),
  /** What onboarding detected about the repository (informational + paths never to commit). */
  detected: z
    .object({
      stack: z.array(z.string()).default([]),
      ignore: z.array(z.string()).default([]),
      sources: z.record(z.string(), z.string()).default({}),
    })
    .prefault({}),
  paths: z
    .object({
      tests: z
        .array(z.string())
        .default(['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**', '**/__tests__/**', 'e2e/**']),
      protected: z
        .array(z.string())
        .default(['devpilot.yaml', '.devpilot/**', '.github/workflows/**', '.env', '.env.*', '*.pem', '*.key', '.git/**']),
      high_risk: z.array(z.string()).default(['migrations/**', '**/migrations/**', '**/auth/**', '**/*.sql']),
    })
    .prefault({}),
  /** Splitting large tasks into parallel subtasks (stage 4). */
  decomposition: z
    .object({
      enabled: z.boolean().default(true),
      max_subtasks: z.number().int().min(2).default(8),
      /** How often the parent checks on its subtasks. */
      poll_seconds: z.number().positive().default(10),
      /** Attempts for the integrator agent on one merge conflict. */
      max_conflict_attempts: z.number().int().positive().default(2),
      /**
       * If the architect returns no split but the change scores at least this much
       * (files + dependents + requirements + risk), it is asked once more, explicitly,
       * whether the plan splits into independent parts. 0 disables the second look.
       */
      suggest_above_score: z.number().int().min(0).default(10),
    })
    .prefault({}),
  approval: z
    .object({
      /** `required`: always wait for a human after the spec is produced. */
      spec: z.enum(['auto', 'required']).default('auto'),
      high_risk_changes: z.enum(['auto', 'required']).default('required'),
      before_pr: z.enum(['auto', 'required']).default('auto'),
      /**
       * Blocking ambiguities in the spec. ask: stop and ask a human.
       * assume: continue with the architect's stated default, recorded as an assumption
       * and listed prominently in the report / PR (for fully unattended runs).
       */
      ambiguities: z.enum(['ask', 'assume']).default('ask'),
    })
    .prefault({}),
  delivery: z
    .object({
      create_pr: z.boolean().default(true),
      push: z.boolean().default(true),
      remote: z.string().default('origin'),
      auto_merge: z.literal(false).default(false),
      require_ci: z.boolean().default(true),
      draft_pr: z.boolean().default(false),
      /** How often to poll CI on the PR. */
      ci_poll_seconds: z.number().positive().default(60),
      /** Give up waiting for CI after this long (task -> BLOCKED). */
      ci_timeout_minutes: z.number().positive().default(60),
      /** If no check shows up at all within this time, CI is NOT_VERIFIED (task -> BLOCKED). */
      ci_no_checks_grace_minutes: z.number().positive().default(5),
    })
    .prefault({}),
});
export type ProjectPolicy = z.infer<typeof ProjectPolicySchema>;

export const PermissionsSchema = z.object({
  roles: z.record(
    RoleName,
    z.object({
      tools: z.array(z.string()),
      /** none: read-only; tests: may only write test files; worktree: may write any non-protected file. */
      write: z.enum(['none', 'tests', 'worktree']),
      /** readonly: Bash limited to inspection commands; full: any non-denied command. */
      bash: z.enum(['none', 'readonly', 'full']),
    }),
  ),
  bash: z.object({
    deny: z.array(z.string()),
    readonly_allow: z.array(z.string()),
  }),
  /** Tool names that are never available to any agent. */
  forbidden_tools: z.array(z.string()).default([]),
});
export type Permissions = z.infer<typeof PermissionsSchema>;
