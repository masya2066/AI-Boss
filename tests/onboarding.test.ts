import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '@devpilot/database';
import { ScriptedAgentRunner } from '@devpilot/agent-runtime';
import { Orchestrator } from '@devpilot/orchestrator';
import { detectProject, loadPolicy } from '@devpilot/policy-engine';
import { IMPACT, POLICY, SOLO, SPEC, baseHandlers, makeRepo, setup, soloHandlers, writeSubtract, writeSubtractTest } from './helpers';
import { handlers as dagHandlers, SUBTASKS } from './fixtures/subtask-plan';

const dir = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'detect-'));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), c);
  }
  return d;
};

test('detection: node/ts with pnpm, python with ruff+pytest, go, and gaps switched off with a reason', () => {
  const node = detectProject(
    dir({
      'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest run', 'test:e2e': 'playwright test' }, devDependencies: { typescript: '5' } }),
      'pnpm-lock.yaml': '',
      'tsconfig.json': '{}',
    }),
  );
  assert.deepEqual(node.stack, ['node-ts (pnpm)']);
  assert.equal(node.commands.setup, 'pnpm install --frozen-lockfile');
  assert.equal(node.commands.typecheck, 'pnpm exec tsc --noEmit');
  assert.equal(node.commands.lint, 'pnpm run lint');
  assert.equal(node.commands.unit_tests, 'pnpm run test');
  assert.equal(node.commands.e2e_tests, 'pnpm run test:e2e');
  assert.equal(node.quality.integration_tests, 'off');
  assert.match(node.notes.integration_tests!, /no integration tests tooling/);
  assert.deepEqual((node.quality.security_scan as any).mode, 'conditional', 'audit only when dependencies change');

  const npmDefault = detectProject(dir({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }));
  assert.equal(npmDefault.commands.unit_tests, 'node --test', 'npm placeholder test script is ignored');

  const py = detectProject(dir({ 'pyproject.toml': '[project]\nname="x"\n[tool.ruff]\nline-length=100\n[tool.pytest.ini_options]\n', 'requirements.txt': 'fastapi\n' }));
  assert.deepEqual(py.stack, ['python (venv)']);
  assert.match(py.commands.setup!, /^python3 -m venv \.venv && \.venv\/bin\/pip install -q -r requirements\.txt/);
  assert.equal(py.commands.unit_tests, '.venv/bin/python -m pytest -q');
  assert.equal(py.commands.lint, '.venv/bin/python -m ruff check .');
  assert.match(py.commands.typecheck!, /compileall/, 'no type checker -> byte-compile as the minimum');
  assert.ok(py.ignore.includes('.venv/'));

  const go = detectProject(dir({ 'go.mod': 'module x\n' }));
  assert.equal(go.commands.unit_tests, 'go test ./...');
  assert.equal(go.commands.typecheck, 'go vet ./...');

  const mk = detectProject(dir({ Makefile: 'test:\n\t./run-tests\n' }));
  assert.equal(mk.commands.unit_tests, 'make test');
  assert.equal(mk.quality.lint, 'off');
});

test('layering: defaults <- detected <- devpilot.yaml (a command in the project file revives a gate detection switched off)', () => {
  const d = dir({ 'detected.yaml': 'commands: { unit_tests: "npm test" }\nquality: { lint: "off", typecheck: "off" }\nnotes: { lint: "no linter", typecheck: "no tc" }\n', 'proj.yaml': 'commands: { lint: "make lint" }\n' });
  const p = loadPolicy(join(d, 'proj.yaml'), undefined, join(d, 'detected.yaml')).project;
  assert.equal(p.commands.unit_tests, 'npm test');
  assert.equal(p.quality.lint, 'required', 'project file gave lint a command');
  assert.equal(p.notes.lint, undefined);
  assert.equal(p.quality.typecheck, 'off');
  assert.equal(p.notes.typecheck, 'no tc');
});

test('any repo without devpilot.yaml: gates come from detection and the task reaches DONE', async () => {
  const env = makeRepo();
  const store = new MemoryStore(join(env.dataDir, 'state.json'));
  await store.init();
  const runner = new ScriptedAgentRunner(soloHandlers());
  const orch = new Orchestrator({ store, runner, dataDir: env.dataDir, workerId: 't' });
  await orch.registerProject({ id: 'bare', repoPath: env.repo }); // no policy file at all -> solo mode
  const t = await orch.run((await orch.createTask({ projectId: 'bare', prompt: 'Add subtract' })).id);
  assert.equal(t.mode, 'solo');
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  assert.equal(t.gates.unit_tests!.status, 'passed');
  assert.match(t.gates.unit_tests!.command ?? '', /npm run test/);
  assert.equal(t.gates.lint!.status, 'skipped');
  assert.match(t.gates.lint!.reason ?? '', /no lint tooling/);
  // setup byproducts are excluded from commits without touching .gitignore
  const exclude = readFileSync(join(env.repo, '.git/info/exclude'), 'utf8');
  assert.match(exclude, /# >>> devpilot[\s\S]*node_modules\/[\s\S]*# <<< devpilot/);
  const dev = runner.calls.find((c) => c.role === 'developer')!;
  assert.match(dev.prompt, /unit_tests: `npm run test`/, 'the session is told which checks the system will run');
});

test('project check: a gate already failing on the base branch is reported and, with adopt, switched off with evidence', async () => {
  const e = await setup(baseHandlers(), POLICY.replace(`lint: "! grep -rn 'debugger' src"`, 'lint: "exit 3"'));
  const plain = await e.orch.checkProject('sample');
  assert.equal(plain.results.find((r) => r.name === 'lint')!.status, 'failed');
  assert.equal(plain.results.find((r) => r.name === 'unit_tests')!.status, 'passed');
  assert.deepEqual(plain.adopted, []);
  // project YAML sets lint explicitly -> adopting writes the detected layer, but the project file still wins
  const adopted = await e.orch.checkProject('sample', { adopt: true });
  assert.deepEqual(adopted.adopted, ['lint']);
  assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: e.repo }).toString().trim().split('\n').length, 1, 'baseline worktree removed');

  // Same on a repo without its own policy: adoption takes effect.
  const env = makeRepo();
  const store = new MemoryStore(join(env.dataDir, 'state.json'));
  await store.init();
  writeFileSync(join(env.repo, 'package.json'), JSON.stringify({ name: 's', type: 'module', scripts: { test: "node --test 'tests/**/*.test.js'", lint: 'exit 1' } }));
  execFileSync('git', ['commit', '-qam', 'lint'], { cwd: env.repo });
  const orch = new Orchestrator({ store, runner: new ScriptedAgentRunner(baseHandlers()), dataDir: env.dataDir, workerId: 't' });
  const p = await orch.registerProject({ id: 'bare', repoPath: env.repo });
  assert.equal(orch.policyFor(p).project.quality.lint, 'required');
  const r = await orch.checkProject('bare', { adopt: true });
  assert.deepEqual(r.adopted, ['lint']);
  const pol = orch.policyFor(p).project;
  assert.equal(pol.quality.lint, 'off');
  assert.match(pol.notes.lint!, /failed on main@[0-9a-f]{8} before any DevPilot change/);
});

test('decomposition second look: a big unsplit plan is reconsidered once and then runs as subtasks', async () => {
  let splitAsked = 0;
  const pol = POLICY.replace('execution: { agent_sandbox: false, mode: pipeline }', 'execution: { agent_sandbox: false, mode: pipeline, max_parallel_agents: 2 }') + 'decomposition: { suggest_above_score: 3 }\n';
  const base = dagHandlers({ subtasks: [] });
  const e = await setup(
    {
      ...base,
      architect: (req) => {
        if (req.prompt.includes('can this plan be split?')) {
          splitAsked++;
          return { subtasks: SUBTASKS, reason: 'three independent functions' };
        }
        return base.architect!(req);
      },
    },
    pol,
  );
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Math v2: subtract, multiply, diff' })).id);
  assert.equal(splitAsked, 1, 'asked once, by the parent only');
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  assert.equal(t.subtasks!.length, 3);
  const ev = (await e.store.listEvents(t.id)).find((x) => x.type === 'decomposition_reconsidered')!;
  assert.equal((ev.data as any).subtasks, 3);
});

test('small change below the threshold is not second-guessed', async () => {
  let splitAsked = 0;
  const h = baseHandlers();
  const e = await setup({ ...h, architect: (req) => (req.prompt.includes('can this plan be split?') ? (splitAsked++, { subtasks: [], reason: 'x' }) : h.architect!(req)) });
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t.state, 'DONE');
  assert.equal(splitAsked, 0);
});

test('unattended mode: blocking ambiguity becomes a loud assumption instead of a stop', async () => {
  const spec = { ...SPEC, ambiguities: [{ question: 'Negative results allowed?', blocking: true, proposedDefault: 'yes, plain a - b' }] };
  const h = baseHandlers({ architect: (req) => (req.prompt.includes(': specification') ? spec : IMPACT) });
  const ask = await setup(h);
  const t1 = await ask.orch.run((await ask.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t1.state, 'AWAITING_APPROVAL');
  const auto = await setup(h, POLICY + 'approval: { ambiguities: assume }\n');
  const t2 = await auto.orch.run((await auto.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t2.state, 'DONE', t2.stopReason ?? '');
  assert.match(t2.assumptions[0]!, /^ASSUMED \(no human asked\): Negative results allowed\? -> yes, plain a - b/);
  assert.match(readFileSync(t2.reportPath!, 'utf8'), /ASSUMED/);
});

test('subtask review is scoped to the part: sibling work is out of scope, the parent review is not', async () => {
  const pol = POLICY.replace('execution: { agent_sandbox: false, mode: pipeline }', 'execution: { agent_sandbox: false, mode: pipeline, max_parallel_agents: 2 }');
  const e = await setup(dagHandlers(), pol);
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Math v2: subtract, multiply, diff' })).id);
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  const reviews = e.runner.calls.filter((c) => c.role === 'reviewer');
  const child = reviews.filter((c) => /## Scope: subtask S\d of /.test(c.prompt));
  assert.equal(child.length, 3, 'each subtask review carries its scope');
  assert.match(child[0]!.prompt, /Do not report missing\nbehaviour that belongs to another part/);
  assert.match(child[0]!.prompt, /Other parts are implemented separately/);
  assert.equal(reviews.length - child.length, 1, 'the integrated review judges the whole task');
});

test('continue after a crash: a subtask still leased by the dead process is waited for, not abandoned', async () => {
  const pol = POLICY.replace('execution: { agent_sandbox: false, mode: pipeline }', 'execution: { agent_sandbox: false, mode: pipeline, max_parallel_agents: 2 }') + 'decomposition: { poll_seconds: 0.3 }\n';
  const e = await setup(dagHandlers(), pol);
  const parent = await e.orch.createTask({ projectId: 'sample', prompt: 'Math v2: subtract, multiply, diff' });
  let t = parent;
  // until the subtasks have been spawned (they are created on the first EXECUTING_SUBTASKS step)
  for (let i = 0; i < 20 && !t.subtasks?.some((s) => s.taskId); i++) {
    await e.orch.step(parent.id);
    t = (await e.store.getTask(parent.id))!;
  }
  assert.equal(t.state, 'EXECUTING_SUBTASKS');
  const s1 = t.subtasks!.find((s) => s.key === 'S1')!.taskId!;
  assert.ok(await e.store.acquireLease(s1, 'crashed-worker', 1200), 'the dead process still holds S1');
  const done = await e.orch.run(parent.id, { waitOnPause: true });
  assert.equal(done.state, 'DONE', done.stopReason ?? '');
  assert.equal((await e.store.getTask(s1))!.state, 'DONE');
});

test('a failed review is never reused for the same commit: a no-op repair gets a fresh review', async () => {
  let reviews = 0;
  const e = await setup(
    baseHandlers({
      reviewer: () =>
        ++reviews === 1
          ? { findings: [{ severity: 'blocker', title: 'HTTP endpoints missing', description: 'belongs to another part', file: 'src/math.js' }], unmetRequirements: [] }
          : { findings: [], unmetRequirements: [] },
      fixer: () => ({ summary: 'out of scope for this part, nothing changed', defectsAddressed: [] }),
    }),
  );
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  assert.equal(reviews, 2);
  assert.equal(t.repairAttempts, 1);
});

test('requirements coverage is repairable: the fixer maps the tests, the gate re-checks them', async () => {
  const e = await setup(
    baseHandlers({
      qa: (req) => {
        writeFileSync(join(req.cwd, 'tests/subtract.test.js'), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { subtract } from '../src/math.js';\ntest('s', () => assert.equal(subtract(5, 3), 2));\n");
        return { testFiles: ['tests/subtract.test.js'], requirementTests: [], notes: ['forgot the mapping'] };
      },
      fixer: (req) => {
        assert.match(req.prompt, /return every requirement -> test files pair in `requirementTests`/);
        return { summary: 'mapped', defectsAddressed: [], requirementTests: [{ requirementId: 'REQ-01', testFiles: ['tests/subtract.test.js'] }] };
      },
    }),
  );
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  assert.deepEqual(t.requirements[0]!.tests, ['tests/subtract.test.js']);
  assert.equal(t.repairAttempts, 1);
});

test('an agent left running by a crashed orchestrator is killed before a new one starts in the worktree', async () => {
  const { spawn } = await import('node:child_process');
  const e = await setup();
  const orphan = spawn('sleep', ['30'], { stdio: 'ignore' });
  const t0 = await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' });
  mkdirSync(join(e.dataDir, 'agents'), { recursive: true });
  writeFileSync(join(e.dataDir, 'agents', `${t0.id}.pid`), `${orphan.pid}\n/bin/sleep\n`);
  const exited = new Promise((r) => orphan.once('exit', r));
  const t = await e.orch.run(t0.id);
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  assert.equal(await Promise.race([exited.then(() => 'killed'), new Promise((r) => setTimeout(() => r('alive'), 2000))]), 'killed');
  assert.ok((await e.store.listEvents(t.id)).some((x) => x.type === 'stale_agent_killed'));
});

test('duration limit counts active work, not wall clock (pauses, human waits and crashes are free)', async () => {
  const e = await setup(baseHandlers(), POLICY.replace('limits:\n', 'limits:\n  max_duration_minutes: 1\n'));
  const t0 = await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' });
  // Created three hours ago (e.g. it waited for a human overnight) but barely worked.
  await e.store.saveTask({ ...t0, startedAt: new Date(Date.now() - 3 * 3600_000).toISOString() }, t0.version);
  const t = await e.orch.run(t0.id);
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  assert.ok(t.activeMs! > 0 && t.activeMs! < 60_000);
  const t1 = await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract again' });
  await e.store.saveTask({ ...t1, activeMs: 61_000 }, t1.version);
  const b = await e.orch.run(t1.id);
  assert.equal(b.state, 'BLOCKED');
  assert.match(b.stopReason!, /duration limit: 1min of active work > 1min/);
});

// ------------------------------------------------------------------- solo --
const SOLO_POLICY = POLICY.replace('mode: pipeline', 'mode: solo');

test('solo: one session builds code + tests; the system verifies and reviews; no pipeline agents', async () => {
  const e = await setup(soloHandlers(), SOLO_POLICY);
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Add a subtract(a, b) function to src/math.js' })).id);
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  assert.deepEqual(e.runner.calls.map((c) => c.role), ['developer', 'reviewer']);
  const states = (await e.store.listEvents(t.id)).filter((x) => x.type === 'state_changed').map((x: any) => x.data.to);
  assert.deepEqual(states, ['IMPLEMENTATION', 'VALIDATION', 'REVIEW', 'DELIVERY', 'DONE']);
  assert.deepEqual(t.requirements.map((r) => [r.id, r.status, r.tests]), [['REQ-01', 'covered', ['tests/subtract.test.js']]]);
  for (const g of Object.values(t.gates).filter((g) => g.required)) assert.equal(g.status, 'passed', g.name);
  const review = e.runner.calls.find((c) => c.role === 'reviewer')!;
  assert.match(review.prompt, /## Original request[\s\S]*Add a subtract\(a, b\) function/, 'reviewer judges against the request, not only the agent’s own requirements');
});

test('solo: a failed review is repaired by resuming the same developer session', async () => {
  let reviews = 0;
  const e = await setup(
    soloHandlers({
      developer: (req) => (writeSubtract(req.cwd, 'a + b'), writeSubtractTest(req.cwd), SOLO), // wrong: tests fail
      reviewer: () => (++reviews, { findings: [], unmetRequirements: [] }),
    }),
    SOLO_POLICY,
  );
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  const fixer = e.runner.calls.find((c) => c.role === 'fixer')!;
  assert.equal(fixer.resumeSessionId, 'scripted-developer', 'repair continues the session that wrote the code');
  assert.equal(t.repairAttempts, 1);
  assert.equal(reviews, 1, 'review only once the gates pass');
});

test('solo: requirements without tests fail coverage -> repair maps them', async () => {
  const e = await setup(
    soloHandlers({
      developer: (req) => (writeSubtract(req.cwd), writeSubtractTest(req.cwd), { ...SOLO, requirements: [{ ...SOLO.requirements[0]!, testFiles: [] }] }),
      fixer: () => ({ summary: 'mapped', defectsAddressed: [], requirementTests: [{ requirementId: 'REQ-01', testFiles: ['tests/subtract.test.js'] }] }),
    }),
    SOLO_POLICY,
  );
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  assert.equal(t.repairAttempts, 1);
});

test('solo is the default; subtasks of a pipeline task stay pipeline', async () => {
  const env = makeRepo(SOLO_POLICY);
  const store = new MemoryStore(join(env.dataDir, 'state.json'));
  await store.init();
  const orch = new Orchestrator({ store, runner: new ScriptedAgentRunner(soloHandlers()), dataDir: env.dataDir, workerId: 't' });
  await orch.registerProject({ id: 'p', repoPath: env.repo });
  assert.equal((await orch.createTask({ projectId: 'p', prompt: 'x' })).mode, 'solo');
  assert.equal((await orch.createTask({ projectId: 'p', prompt: 'x', mode: 'pipeline' })).mode, 'pipeline');
});

test('reviewer: calibrated severity rules; per-role model and effort are honoured', async () => {
  const runs: { role: string; model: string; effort: string }[] = [];
  const h = soloHandlers();
  const e = await setup(h, SOLO_POLICY + 'agents: { models: { reviewer: claude-sonnet-5-5 }, efforts: { reviewer: medium } }\n');
  const orig = e.runner.run.bind(e.runner);
  (e.runner as any).run = (req: any) => (runs.push({ role: req.role, model: req.model, effort: req.effort }), orig(req));
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  assert.deepEqual(runs.find((r) => r.role === 'reviewer'), { role: 'reviewer', model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.equal(runs.find((r) => r.role === 'developer')!.model, 'claude-opus-5-5');
  const review = e.runner.calls.find((c) => c.role === 'reviewer')!;
  assert.match(review.prompt, /blocker\/major ONLY for/);
  assert.match(review.prompt, /do not re-run the test suite/);
});
