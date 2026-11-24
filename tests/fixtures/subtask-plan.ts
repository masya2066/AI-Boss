import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScriptedHandler } from '@devpilot/agent-runtime';
import type { AgentRole } from '@devpilot/shared';
import { POLICY, baseHandlers } from '../helpers';

export const PAR_POLICY = POLICY.replace('execution: { agent_sandbox: false, mode: pipeline }', 'execution: { agent_sandbox: false, mode: pipeline, max_parallel_agents: 2 }');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reqIds = (prompt: string) => [...new Set([...prompt.matchAll(/- (REQ-\d+):/g)].map((m) => m[1]!))];
const subKey = (prompt: string) => prompt.match(/subtask (S\d)/)?.[1];

const SPEC = {
  title: 'Math v2',
  requirements: [
    { id: 'REQ-01', description: 'subtract(a, b) in src/math.js', acceptanceCriteria: ['subtract(5,3)=2'] },
    { id: 'REQ-02', description: 'multiply(a, b) in src/ops.js', acceptanceCriteria: ['multiply(2,3)=6'] },
    { id: 'REQ-03', description: 'diff(xs) in src/calc.js uses subtract', acceptanceCriteria: ['diff([5,3])=2'] },
  ],
  ambiguities: [],
  assumptions: [],
};
const impact = (subtasks: unknown[]) => ({ summary: 's', filesToChange: ['src/math.js'], modules: [], risks: [], plan: ['p'], touchesDatabase: false, touchesAuth: false, touchesPublicApi: false, subtasks });
export const SUBTASKS = [
  { key: 'S1', title: 'subtract', description: 'add subtract', requirementIds: ['REQ-01'], files: ['src/math.js'], dependsOn: [] },
  { key: 'S2', title: 'multiply', description: 'add multiply', requirementIds: ['REQ-02'], files: ['src/ops.js'], dependsOn: [] },
  { key: 'S3', title: 'diff', description: 'add diff using subtract', requirementIds: ['REQ-03'], files: ['src/calc.js'], dependsOn: ['S1'] },
];

export const CODE: Record<string, (cwd: string) => void> = {
  S1: (cwd) => appendFileSync(join(cwd, 'src/math.js'), '\nexport function subtract(a, b) {\n  return a - b;\n}\n'),
  S2: (cwd) => writeFileSync(join(cwd, 'src/ops.js'), 'export const multiply = (a, b) => a * b;\n'),
  S3: (cwd) => appendFileSync(join(cwd, 'src/calc.js'), "import { subtract } from './math.js';\nexport const diff = (xs) => xs.reduce((a, b) => subtract(a, b));\n"),
};
const TESTS: Record<string, [string, string]> = {
  'REQ-01': ['tests/subtract.test.js', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { subtract } from '../src/math.js';\ntest('s', () => assert.equal(subtract(5, 3), 2));\n"],
  'REQ-02': ['tests/multiply.test.js', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { multiply } from '../src/ops.js';\ntest('m', () => assert.equal(multiply(2, 3), 6));\n"],
  'REQ-03': ['tests/diff.test.js', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { diff } from '../src/calc.js';\ntest('d', () => assert.equal(diff([5, 3]), 2));\n"],
};

export function handlers(o: { subtasks?: unknown[]; code?: Record<string, (cwd: string) => void>; over?: Partial<Record<AgentRole, ScriptedHandler>>; log?: { key: string; start: number; end: number }[] } = {}) {
  const code = o.code ?? CODE;
  return baseHandlers({
    architect: (req) => (req.prompt.includes(': specification') ? SPEC : req.prompt.includes('This is subtask') ? impact([]) : impact(o.subtasks ?? SUBTASKS)),
    developer: async (req) => {
      const key = subKey(req.prompt)!;
      const start = Date.now();
      await sleep(250);
      code[key]!(req.cwd);
      o.log?.push({ key, start, end: Date.now() });
      return { summary: key, filesChanged: [], notes: [] };
    },
    qa: (req) => {
      const ids = reqIds(req.prompt);
      for (const id of ids) writeFileSync(join(req.cwd, TESTS[id]![0]), TESTS[id]![1]);
      return { testFiles: ids.map((i) => TESTS[i]![0]), requirementTests: ids.map((i) => ({ requirementId: i, testFiles: [TESTS[i]![0]] })), notes: [] };
    },
    fixer: () => ({ summary: 'noop', defectsAddressed: [] }),
    ...o.over,
  });
}

