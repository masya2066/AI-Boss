import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, get, type IncomingMessage } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { computeMetrics } from '@devpilot/metrics';
import { LocalScheduler } from '@devpilot/orchestrator';
import { TelegramBot, attachNotifier } from '@devpilot/notifier';
import { ScriptedAgentRunner } from '@devpilot/agent-runtime';
import { loadBenchmarks, runBenchmarks } from '@devpilot/benchmark';
import { buildApi } from '../apps/api/src/app';
import { POLICY, baseHandlers, setup, writeSubtract } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const body = (req: IncomingMessage) => new Promise<string>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

test('metrics: first-pass, autonomy, coverage, cost per accepted task, recurring failures', async () => {
  let bug = false;
  let stuck = false;
  const e = await setup(
    baseHandlers({
      developer: (req) => (writeSubtract(req.cwd, bug || stuck ? 'a + b' : 'a - b'), { summary: 'x', filesChanged: [], notes: [] }),
      fixer: (req) => (stuck ? undefined : writeSubtract(req.cwd), { summary: 'fix', defectsAddressed: [] }),
    }),
  );
  const run = async (p: string) => e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: p })).id);
  const a = await run('Add subtract (clean)');
  bug = true;
  const b = await run('Add subtract (needs a repair)');
  bug = false;
  stuck = true;
  const c = await run('Add subtract (gets stuck)');
  assert.deepEqual([a.state, b.state, c.state], ['DONE', 'DONE', 'BLOCKED']);
  const m = await computeMetrics(e.store, { projectId: 'sample' });
  assert.equal(m.tasks.total, 3);
  assert.equal(m.firstPassSuccessRate, 0.5);
  assert.equal(m.autonomousCompletionRate, Number((2 / 3).toFixed(4)));
  assert.equal(m.requirementCoverage, 1);
  assert.ok(m.costPerAcceptedTaskUsd! > 0);
  assert.equal(m.totalCostUsd, Number((a.costUsd + b.costUsd + c.costUsd).toFixed(4)));
  assert.ok(m.gateFailures.find((g) => g.gate === 'unit_tests')!.failures >= 4);
  assert.ok(m.recurringFailures[0]!.occurrences >= 3, 'same failure fingerprint across attempts/tasks');
  assert.ok(m.costByRole.developer! > 0 && m.costByModel['claude-opus-5-5']!.runs > 0);
  await e.store.appendEvent(a.id, 'escaped_defect', { description: 'found in prod' });
  assert.equal((await computeMetrics(e.store)).escapedDefects.reportedAfterDelivery, 1);
});

test('model routing by complexity: small tasks use the small tier, judgement roles stay on top, fixer escalates', async () => {
  const policy = POLICY.replace('execution: { agent_sandbox: false, mode: pipeline }', 'execution: { agent_sandbox: false, mode: pipeline }\nagents: { routing: { enabled: true, escalate_fixer_after: 1 } }');
  let attempts = 0;
  const e = await setup(
    baseHandlers({
      developer: (req) => (writeSubtract(req.cwd, 'a + b'), { summary: 'x', filesChanged: [], notes: [] }),
      fixer: (req) => (++attempts >= 2 ? writeSubtract(req.cwd) : undefined, { summary: 'f', defectsAddressed: [] }),
    }),
    policy,
  );
  const t = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(t.state, 'DONE', t.stopReason ?? '');
  assert.ok(t.complexity && t.complexity.score <= 4, `score ${t.complexity?.score}`);
  const runs = await e.store.listAgentRuns(t.id);
  const model = (role: string, n = 0) => runs.filter((r) => r.role === role)[n]!.model;
  assert.equal(model('researcher'), 'claude-opus-5-5', 'before impact analysis: default model');
  assert.equal(model('developer'), 'claude-sonnet-5-5');
  assert.equal(model('qa'), 'claude-sonnet-5-5');
  assert.equal(model('reviewer'), 'claude-sonnet-5-5', 'an explicit per-role model (default: measured Sonnet reviewer) wins over routing');
  assert.equal(model('architect', 1), 'claude-opus-5-5', 'architect stays on the top tier after impact analysis');
  assert.equal(model('fixer', 0), 'claude-sonnet-5-5');
  assert.equal(model('fixer', 1), 'claude-opus-5-5', 'fixer escalated after a failed repair');
});

test('daily budget per project pauses new work until tomorrow', async () => {
  // scripted agent runs cost $0.01 each; a full task is 6 runs
  const e = await setup(baseHandlers(), POLICY.replace('limits:\n', 'limits:\n  max_daily_cost_usd: 0.065\n'));
  const a = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id);
  assert.equal(a.state, 'DONE');
  const b = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Another one' })).id);
  assert.equal(b.waitReason, 'budget');
  assert.ok(Date.parse(b.pausedUntil!) > Date.now() + 60_000, 'paused until tomorrow');
  assert.notEqual(b.state, 'DONE');
  assert.equal(await e.orch.step(b.id), 'paused', 'stays paused');
  assert.ok((await e.store.listEvents(b.id)).some((x) => x.type === 'paused_daily_budget'));
});

test('notifications: Telegram + signed webhook on approval-needed and DONE; subtasks stay quiet', async () => {
  const tg: { chat_id: string; text: string }[] = [];
  const hooks: { sig: string; raw: string }[] = [];
  const srv = createServer(async (req, res) => {
    const raw = await body(req);
    if (req.url?.includes('/sendMessage')) tg.push(JSON.parse(raw));
    if (req.url === '/hook') hooks.push({ sig: String(req.headers['x-devpilot-signature']), raw });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  try {
    let asked = false;
    const e = await setup(
      baseHandlers({
        architect: (req) =>
          req.prompt.includes(': specification')
            ? { title: 'x', requirements: [{ id: 'REQ-01', description: 'subtract', acceptanceCriteria: ['5-3=2'] }], ambiguities: asked ? [] : ((asked = true), [{ question: 'Floats too?', blocking: true }]), assumptions: [] }
            : (baseHandlers().architect as any)(req),
      }),
    );
    attachNotifier(e.orch, { telegram: { token: 'T0K', chatId: '42', apiBase: `http://127.0.0.1:${port}` }, webhook: { url: `http://127.0.0.1:${port}/hook`, secret: 's3cret' }, on: ['AWAITING_APPROVAL', 'DONE'], dashboardUrl: 'http://dp.local/dashboard' });
    const id = (await e.orch.createTask({ projectId: 'sample', prompt: 'Add subtract' })).id;
    await e.orch.run(id);
    await e.orch.approve(id, 'integers only');
    await e.orch.run(id);
    await sleep(300);
    assert.equal(tg.length, 2);
    assert.equal(tg[0]!.chat_id, '42');
    assert.match(tg[0]!.text, /Нужно решение[\s\S]*Floats too\?[\s\S]*\/approve TASK-/);
    assert.match(tg[1]!.text, /Готово[\s\S]*Проверки: \d+\/\d+[\s\S]*dp\.local\/dashboard\/#\/tasks\//);
    assert.equal(hooks.length, 2);
    for (const h of hooks) assert.equal(h.sig, 'sha256=' + createHmac('sha256', 's3cret').update(h.raw).digest('hex'));
    assert.equal(JSON.parse(hooks[1]!.raw).task.state, 'DONE');
  } finally {
    srv.close();
  }
});

test('telegram bot: commands from the owner chat only; /run, /status, /approve, /metrics', async () => {
  const sent: { chat_id: string; text: string }[] = [];
  let served = false;
  const srv = createServer(async (req, res) => {
    if (req.url?.includes('/getUpdates')) {
      const updates = served ? [] : [
        { update_id: 1, message: { chat: { id: 999 }, text: '/tasks' } },
        { update_id: 2, message: { chat: { id: 42 }, text: '/tasks' } },
      ];
      served = true;
      if (!updates.length) await sleep(200);
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: updates }));
    }
    sent.push(JSON.parse(await body(req)));
    res.writeHead(200).end('{"ok":true}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  const e = await setup();
  const scheduled: string[] = [];
  const bot = new TelegramBot({ telegram: { token: 'T', chatId: '42', apiBase: `http://127.0.0.1:${port}` }, orchestrator: e.orch, schedule: async (id) => void scheduled.push(id) });
  try {
    bot.start();
    await sleep(600);
    assert.equal(sent.length, 1, 'foreign chat ignored');
    assert.equal(sent[0]!.chat_id, '42');
    assert.match(await bot.handle('/run sample Add a subtract function please'), /Поставлена TASK-/);
    assert.equal(scheduled.length, 1);
    await e.orch.run(scheduled[0]!);
    assert.match(await bot.handle(`/status ${scheduled[0]}`), /DONE[\s\S]*Проверки: ✓/);
    assert.match(await bot.handle('/metrics sample'), /Задач: 1 \(готово 1/);
    assert.match(await bot.handle('/approve TASK-NOPE ok'), /^Ошибка/);
    assert.match(await bot.handle('/help'), /\/approve/);
  } finally {
    bot.stop();
    srv.close();
  }
});

test('API (embedded mode, no Redis): token, tasks, live SSE, approvals, metrics, escaped defects, dashboard', async () => {
  let asked = false;
  const e = await setup(
    baseHandlers({
      architect: (req) =>
        req.prompt.includes(': specification')
          ? { title: 'x', requirements: [{ id: 'REQ-01', description: 'subtract', acceptanceCriteria: ['5-3=2'] }], ambiguities: asked ? [] : ((asked = true), [{ question: 'Floats?', blocking: true }]), assumptions: [] }
          : (baseHandlers().architect as any)(req),
    }),
  );
  const sched = new LocalScheduler(e.orch, e.store);
  const app = buildApi({ orchestrator: e.orch, schedule: (id) => sched.schedule(id), token: 'tok', mode: 'embedded' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const H = { authorization: 'Bearer tok', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/tasks`)).status, 401);
    const html = await fetch(`${base}/dashboard/`);
    assert.equal(html.status, 200, 'dashboard is public (the token is entered in the UI)');
    assert.match(await html.text(), /<title>DevPilot<\/title>/);
    assert.equal((await fetch(`${base}/dashboard/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
    // raw request (fetch would normalise ../ away): encoded slashes reach the wildcard handler
    const trav = await new Promise<{ status: number; text: string }>((res) =>
      get({ host: '127.0.0.1', port: (app.server.address() as AddressInfo).port, path: '/dashboard/..%2f..%2f..%2fpackage.json' }, (r) => {
        let t = '';
        r.on('data', (c) => (t += c));
        r.on('end', () => res({ status: r.statusCode!, text: t }));
      }),
    );
    assert.equal(trav.status, 404, 'no path traversal out of the dashboard folder');
    assert.doesNotMatch(trav.text, /"workspaces"/);

    // live stream
    const ac = new AbortController();
    const seen: string[] = [];
    const sse = fetch(`${base}/events/stream?token=tok`, { signal: ac.signal }).then(async (r) => {
      const rd = r.body!.getReader();
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        for (const m of new TextDecoder().decode(value).matchAll(/data: (.+)/g)) seen.push(JSON.parse(m[1]!).type);
      }
    }).catch(() => {});

    const t: any = await (await fetch(`${base}/tasks`, { method: "POST", headers: H, body: JSON.stringify({ projectId: "sample", prompt: "Add subtract" }) })).json();
    await sched.idle();
    const approvals: any = await (await fetch(`${base}/approvals`, { headers: H })).json();
    assert.equal(approvals[0].id, t.id);
    await fetch(`${base}/tasks/${t.id}/approve`, { method: 'POST', headers: H, body: JSON.stringify({ answer: 'integers' }) });
    await sched.idle();
    const detail: any = await (await fetch(`${base}/tasks/${t.id}`, { headers: H })).json();
    assert.equal(detail.task.state, 'DONE');
    assert.ok(detail.agentRuns.length >= 6);
    assert.match(await (await fetch(`${base}/tasks/${t.id}/report`, { headers: H })).text(), /Quality gates/);
    assert.equal((await fetch(`${base}/tasks/${t.id}/escaped-defect`, { method: 'POST', headers: H, body: JSON.stringify({ description: 'wrong rounding in prod' }) })).status, 201);
    const m: any = await (await fetch(`${base}/metrics?projectId=sample`, { headers: H })).json();
    assert.equal(m.tasks.done, 1);
    assert.equal(m.escapedDefects.reportedAfterDelivery, 1);
    assert.equal(m.autonomousCompletionRate, 0, 'needed a human answer');
    await sleep(1300);
    ac.abort();
    await sse;
    assert.ok(seen.includes('state_changed') && seen.includes('agent_finished') && seen.includes('escaped_defect'), `SSE saw: ${[...new Set(seen)].join(',')}`);
  } finally {
    await app.close();
  }
});

test('benchmark harness: hidden acceptance tests judge DevPilot and the plain baseline the same way', async () => {
  const correct = `export class CancelWindowError extends Error {}
export class AlreadyCancelledError extends Error {}
export function createBooking(id, startsAt) { return { id, startsAt: new Date(startsAt), status: 'active' }; }
export function cancelBooking(b, now = new Date()) {
  if (b.status === 'cancelled') throw new AlreadyCancelledError(b.id);
  if (b.startsAt.getTime() - new Date(now).getTime() < 12 * 3600_000) throw new CancelWindowError(b.id);
  b.status = 'cancelled'; b.cancelledAt = new Date(now); return b;
}
`;
  const runner = new ScriptedAgentRunner({
    researcher: () => ({ summary: 's', relevantFiles: ['src/booking.js'], existingPatterns: [], risks: [], searchTerms: ['cancel', 'booking'] }),
    architect: (req) =>
      req.prompt.includes(': specification')
        ? { title: 'cancel window', requirements: [{ id: 'REQ-01', description: 'cancel window', acceptanceCriteria: ['<12h throws'] }], ambiguities: [], assumptions: [] }
        : { summary: 's', filesToChange: ['src/booking.js'], modules: [], risks: [], plan: ['p'], touchesDatabase: false, touchesAuth: false, touchesPublicApi: false },
    // benchmarks run DevPilot in its default (solo) mode: one session writes code + tests
    developer: (req) => (
      writeFileSync(join(req.cwd, 'src/booking.js'), correct),
      writeFileSync(join(req.cwd, 'tests/window.test.js'), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { cancelBooking, createBooking, CancelWindowError } from '../src/booking.js';\ntest('w', () => assert.throws(() => cancelBooking(createBooking('x', new Date(Date.now() + 3600_000))), CancelWindowError));\n"),
      { title: 'cancel window', summary: 'done', requirements: [{ id: 'REQ-01', description: 'cancel window', acceptanceCriteria: ['<12h throws'], testFiles: ['tests/window.test.js'] }] }
    ),
    qa: (req) => (writeFileSync(join(req.cwd, 'tests/window.test.js'), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { cancelBooking, createBooking, CancelWindowError } from '../src/booking.js';\ntest('w', () => assert.throws(() => cancelBooking(createBooking('x', new Date(Date.now() + 3600_000))), CancelWindowError));\n"), { testFiles: ['tests/window.test.js'], requirementTests: [{ requirementId: 'REQ-01', testFiles: ['tests/window.test.js'] }], notes: [] }),
    reviewer: () => ({ findings: [], unmetRequirements: [] }),
    fixer: () => ({ summary: 'n', defectsAddressed: [] }),
  });
  // "Plain" baseline that forgets one rule (no AlreadyCancelledError) — like a single unchecked session might.
  const baseline = async ({ cwd }: { cwd: string }) => (writeFileSync(join(cwd, 'src/booking.js'), correct.replace("if (b.status === 'cancelled') throw new AlreadyCancelledError(b.id);\n", '')), { costUsd: 0.3, ok: true });
  const root = join(import.meta.dirname, '..', 'benchmarks');
  let inFlight = 0;
  let maxInFlight = 0;
  const countedBaseline = async (a: { cwd: string; prompt: string; timeoutMs: number }) => {
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await new Promise((r) => setTimeout(r, 150));
    const r = await baseline(a);
    inFlight--;
    return r;
  };
  const { results, reportPath } = await runBenchmarks({ benchmarks: loadBenchmarks(root, ['cancel-window']), modes: ['devpilot', 'baseline'], trials: 2, concurrency: 4, runner, baseline: countedBaseline, outDir: join(root, '..', '.devpilot', 'bench-test') });
  assert.equal(results.length, 4, '2 trials x 2 modes');
  assert.ok(maxInFlight >= 2, 'baseline trials ran concurrently');
  assert.deepEqual(results.map((r) => `${r.mode}#${r.trial}`), ['devpilot#1', 'baseline#1', 'devpilot#2', 'baseline#2']);
  const dp = results.find((r) => r.mode === 'devpilot')!;
  const bl = results.find((r) => r.mode === 'baseline')!;
  assert.equal(dp.accepted, true, dp.acceptanceLog);
  assert.equal(dp.passed, 6);
  assert.equal(dp.taskState, 'DONE');
  assert.equal(bl.accepted, false);
  assert.ok(bl.failed >= 1 && bl.passed >= 4);
  assert.ok(existsSync(reportPath));
  assert.match(readFileSync(reportPath, 'utf8'), /devpilot\*\*: accepted 2\/2, hidden tests 12\/12[\s\S]*baseline\*\*: accepted 0\/2/);
});

test('benchmark policy: overrides are merged as data, unattended approvals by default', async () => {
  const { benchPolicy } = await import('@devpilot/benchmark');
  const y = (await import('yaml')).default.parse(benchPolicy({ policy: 'commands:\n  lint: "npm run lint"\nquality:\n  lint: required\n' }));
  assert.equal(y.commands.unit_tests, 'npm test', 'default kept');
  assert.equal(y.commands.lint, 'npm run lint');
  assert.equal(y.quality.lint, 'required');
  assert.equal(y.quality.security_scan, 'off');
  assert.deepEqual(y.approval, { ambiguities: 'assume', high_risk_changes: 'auto' });
});
