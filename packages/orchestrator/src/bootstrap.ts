import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, type Store } from '@devpilot/database';
import { ClaudeAgentRunner, ClaudeCliRunner, type AgentRunner } from '@devpilot/agent-runtime';
import { DEFAULT_POLICIES_DIR, loadPolicy } from '@devpilot/policy-engine';
import { Orchestrator } from './orchestrator';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const AGENTS_DIR = join(ROOT, 'agents');

export interface Runtime {
  store: Store;
  orchestrator: Orchestrator;
  dataDir: string;
}

/**
 * Shared wiring for api / worker / cli.
 * DATABASE_URL set -> PostgreSQL, otherwise a JSON file under DEVPILOT_DATA_DIR.
 */
export async function bootstrap(o: { runner?: AgentRunner; workerId?: string; log?: (l: string) => void } = {}): Promise<Runtime> {
  const dataDir = resolve(process.env.DEVPILOT_DATA_DIR ?? join(process.cwd(), '.devpilot'));
  const store = await openStore({ databaseUrl: process.env.DATABASE_URL, fallbackFile: join(dataDir, 'state.json') });
  // The runner needs a policy for tool permissions; it is re-resolved per project below.
  const runner: AgentRunner =
    o.runner ??
    ({
      run: async (req) => {
        const project = await store.getProject((await store.getTask(req.taskId))!.projectId);
        const policy = project ? orchestrator.policyFor(project) : loadPolicy(undefined, DEFAULT_POLICIES_DIR);
        // Default: your Claude subscription via the official CLI. `agents.auth: api` switches to the Agent SDK + API key.
        const r =
          policy.project.agents.auth === 'subscription'
            ? new ClaudeCliRunner({ policy, policyPath: project?.policyPath, policiesDir: DEFAULT_POLICIES_DIR, agentsDir: AGENTS_DIR })
            : new ClaudeAgentRunner({ policy, agentsDir: AGENTS_DIR });
        return r.run(req);
      },
    } satisfies AgentRunner);
  const orchestrator: Orchestrator = new Orchestrator({ store, runner, dataDir, workerId: o.workerId, log: o.log });
  return { store, orchestrator, dataDir };
}
