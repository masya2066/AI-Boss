import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DockerExecutor } from '@devpilot/sandbox-manager';
import { POLICY, baseHandlers, makeRepo, setup } from './helpers';

const IMAGE = 'node:24-alpine';
const dockerOk = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const skip = !dockerOk && `docker or ${IMAGE} not available`;

test('container gate: no network, no host env secrets, files owned by host user', { skip }, async () => {
  const env = makeRepo();
  process.env.SUPER_SECRET = 'hunter2';
  const ex = new DockerExecutor({ image: IMAGE, network: 'none', cpus: '1', memory: '512m' });
  const net = await ex.run(`node -e "fetch('https://example.com').then(()=>process.exit(0),()=>process.exit(3))"`, { cwd: env.repo, timeoutMs: 60_000 });
  assert.equal(net.exitCode, 3, 'network must be unreachable');
  const envr = await ex.run('echo "secret=${SUPER_SECRET:-none}"; id -u; touch written.txt', { cwd: env.repo, timeoutMs: 60_000 });
  assert.match(envr.stdout, /secret=none/);
  assert.equal(statSync(join(env.repo, 'written.txt')).uid, process.getuid!());
  delete process.env.SUPER_SECRET;
});

test('full task with every gate executed inside throwaway containers + evidence collected', { skip, timeout: 180_000 }, async () => {
  const policy = POLICY.replace(
    'execution: { agent_sandbox: false, mode: pipeline }',
    `execution: { agent_sandbox: false, mode: pipeline, containerized: true, container_image: '${IMAGE}', container_network: none }`,
  )
    .replace(`  unit_tests: "node --test 'tests/**/*.test.js'"`, `  unit_tests: "mkdir -p test-results && node --test --test-reporter=spec --test-reporter-destination=test-results/unit.txt 'tests/**/*.test.js'"`)
    .replace('quality:\n', 'quality:\n  unit_tests: { mode: required, collect: [test-results] }\n');
  const e = await setup(baseHandlers(), policy);
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  assert.match(t.gates.unit_tests!.reason!, /\[docker\]/);
  const art = t.gates.unit_tests!.artifacts!;
  assert.ok(art.length === 1 && existsSync(join(art[0]!, 'unit.txt')), 'test report kept as evidence');
});
