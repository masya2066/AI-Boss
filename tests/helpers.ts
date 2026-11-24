import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '@devpilot/database';
import { Orchestrator } from '@devpilot/orchestrator';
import { ScriptedAgentRunner, type ScriptedHandler } from '@devpilot/agent-runtime';
import type { AgentRole } from '@devpilot/shared';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

export const POLICY = `
project: { default_branch: main }
execution: { agent_sandbox: false }
commands:
  typecheck: "node --check src/math.js"
  lint: "! grep -rn 'debugger' src"
  unit_tests: "node --test 'tests/**/*.test.js'"
  security_scan: "true"
quality:
  e2e_tests: off
  integration_tests: off
limits:
  max_repair_attempts: 4
  max_same_failure: 3
  gate_timeout_seconds: 60
delivery: { create_pr: false }
`;

/** A tiny git repo with a JS module and node:test tests. */
export function makeRepo(policy = POLICY) {
  const root = mkdtempSync(join(tmpdir(), 'devpilot-test-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, 'src/math.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  writeFileSync(join(repo, 'src/calc.js'), "import { add } from './math.js';\nexport const sum = (xs) => xs.reduce(add, 0);\n");
  writeFileSync(join(repo, 'tests/add.test.js'), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../src/math.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'sample', type: 'module', scripts: { test: "node --test 'tests/**/*.test.js'" } }, null, 2));
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'config', 'user.name', 't');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'init');
  const policyPath = join(root, 'devpilot.yaml');
  writeFileSync(policyPath, policy);
  return { root, repo, policyPath, dataDir: join(root, 'data') };
}

export const SPEC = {
  title: 'Add subtract',
  requirements: [{ id: 'REQ-01', description: 'subtract(a, b) returns a - b', acceptanceCriteria: ['subtract(5, 3) === 2', 'subtract(0, 4) === -4'] }],
  ambiguities: [],
  assumptions: ['integers only'],
};
export const IMPACT = {
  summary: 'math module gets subtract',
  filesToChange: ['src/math.js'],
  modules: ['math'],
  risks: [],
  plan: ['add subtract to src/math.js', 'test it'],
  touchesDatabase: false,
  touchesAuth: false,
  touchesPublicApi: false,
};

export const writeSubtract = (cwd: string, body = 'a - b') =>
  writeFileSync(join(cwd, 'src/math.js'), `export function add(a, b) {\n  return a + b;\n}\n\nexport function subtract(a, b) {\n  return ${body};\n}\n`);

export const writeSubtractTest = (cwd: string) =>
  writeFileSync(
    join(cwd, 'tests/subtract.test.js'),
    "import test from 'node:test';\nimport assert from 'node:assert';\nimport { subtract } from '../src/math.js';\ntest('subtract', () => {\n  assert.equal(subtract(5, 3), 2);\n  assert.equal(subtract(0, 4), -4);\n});\n",
  );

export function baseHandlers(over: Partial<Record<AgentRole, ScriptedHandler>> = {}): Partial<Record<AgentRole, ScriptedHandler>> {
  return {
    researcher: () => ({ summary: 'math.js exports add; calc.js uses it', relevantFiles: ['src/math.js'], existingPatterns: ['named exports'], risks: [], searchTerms: ['math', 'subtract'] }),
    architect: (req) => (req.prompt.includes(': specification') ? SPEC : IMPACT),
    developer: (req) => {
      writeSubtract(req.cwd);
      return { summary: 'added subtract', filesChanged: ['src/math.js'], notes: [] };
    },
    qa: (req) => {
      writeSubtractTest(req.cwd);
      return { testFiles: ['tests/subtract.test.js'], requirementTests: [{ requirementId: 'REQ-01', testFiles: ['tests/subtract.test.js'] }], notes: [] };
    },
    reviewer: () => ({ findings: [], unmetRequirements: [] }),
    fixer: (req) => {
      writeSubtract(req.cwd);
      return { summary: 'fixed subtract', defectsAddressed: [] };
    },
    ...over,
  };
}

export async function setup(handlers = baseHandlers(), policy = POLICY, storeFile?: string) {
  const env = makeRepo(policy);
  const store = new MemoryStore(storeFile ?? join(env.dataDir, 'state.json'));
  await store.init();
  const runner = new ScriptedAgentRunner(handlers);
  const orch = new Orchestrator({ store, runner, dataDir: env.dataDir, workerId: 'test' });
  await orch.registerProject({ id: 'sample', repoPath: env.repo, policyPath: env.policyPath });
  return { ...env, store, runner, orch };
}
