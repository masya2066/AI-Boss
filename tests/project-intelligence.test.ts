import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildContext,
  buildIndex,
  consumersOfChange,
  parseHunks,
  recordFeature,
  relevantKnowledge,
  symbolConsumers,
} from '@devpilot/project-intelligence';
import { setup } from './helpers';
import { bookingRepo } from './fixtures/booking-repo';

const TESTS = ['**/*.test.*', 'test/**', 'tests/**'];
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd }).toString();

test('index: endpoints, pages, data model, env, integrations, CI across frameworks', async () => {
  const repo = bookingRepo();
  const idx = await buildIndex(repo, { testGlobs: TESTS });
  const api = idx.api.map((a) => `${a.method} ${a.path} [${a.framework}]`);
  for (const e of ['POST /bookings/:id/cancel [express-like]', 'GET /staff/:id [nestjs]', 'GET /api/bookings [next-app]', 'GET /health [fastapi]']) assert.ok(api.includes(e), `${e} in ${api.join(' | ')}`);
  assert.deepEqual(idx.pages.map((p) => p.path), ['/bookings/:id']);
  const prismaBooking = idx.tables.find((t) => t.source === 'prisma' && t.alias === 'Booking')!;
  assert.equal(prismaBooking.name, 'bookings');
  assert.deepEqual(prismaBooking.relations, ['Staff']);
  assert.ok(idx.tables.find((t) => t.source === 'sql' && t.name === 'bookings')!.columns.includes('cancelled_at'));
  const users = idx.tableUsers.booking!;
  for (const f of ['apps/api/src/services/booking-service.ts', 'apps/api/src/services/notifications.ts', 'apps/api/src/analytics/report.ts', 'prisma/schema.prisma', 'migrations/001_init.sql'])
    assert.ok(users.includes(f), `${f} uses bookings`);
  assert.deepEqual(idx.env.SMTP_HOST!.sort(), ['.env.example', 'apps/api/src/services/notifications.ts']);
  assert.ok(idx.integrations['Email delivery']?.includes('apps/api/src/services/notifications.ts'));
  assert.ok(idx.integrations['HTTP api.mixpanel.com']);
  assert.ok(idx.integrations['Database client']);
  assert.deepEqual(idx.ci[0]!.jobs[0]!.run.filter((r) => !r.startsWith('uses')), ['npm ci', 'npm test']);
  assert.ok(idx.env.NPM_TOKEN, 'CI secrets are listed as env');
});

test('module resolution: workspaces, tsconfig paths, barrels, python relative imports', async () => {
  const idx = await buildIndex(bookingRepo(), { testGlobs: TESTS });
  assert.ok(idx.imports['apps/api/src/services/booking-service.ts']!.includes('packages/db/src/index.ts'), 'workspace package');
  assert.ok(idx.imports['apps/web/src/app/bookings/[id]/page.tsx']!.includes('apps/web/src/lib/api.ts'), 'tsconfig paths alias');
  assert.ok(idx.imports['worker/jobs.py']!.includes('worker/db.py'), 'python relative import');
  assert.ok(idx.externals.express && idx.externals['@nestjs/common'] && idx.externals.fastapi);
  // symbol-level, through the barrel apps/api/src/index.ts
  const cons = symbolConsumers(idx, 'apps/api/src/services/booking-service.ts', 'canCancel').map((c) => c.file).sort();
  assert.deepEqual(cons, ['apps/api/src/admin.ts', 'apps/api/src/index.ts', 'apps/api/test/booking-service.test.ts']);
  assert.ok(!symbolConsumers(idx, 'apps/api/src/services/booking-service.ts', 'cancelBooking').some((c) => c.file.endsWith('admin.ts')), 'admin does not use cancelBooking… directly');
  assert.ok(idx.testsFor['packages/db/src/index.ts']!.includes('apps/api/test/booking-service.test.ts'), 'transitive test coverage');
});

test('concept search finds the feature AND its consumers via shared tables, not just keyword files', async () => {
  const idx = await buildIndex(bookingRepo(), { testGlobs: TESTS });
  const ctx = buildContext(idx, { terms: ['cancel booking'] });
  const files = ctx.files.map((f) => f.file);
  // The feature's core (service + its endpoint) comes first, in either order.
  assert.deepEqual(files.slice(0, 2).sort(), ['apps/api/src/routes/bookings.ts', 'apps/api/src/services/booking-service.ts']);
  const why = (f: string) => ctx.files.find((x) => x.file === f)?.why.join(' ') ?? '';
  assert.match(why('apps/api/src/services/notifications.ts'), /booking-service|shares table/);
  assert.match(why('apps/api/src/analytics/report.ts'), /matches|shares table "booking"/);
  assert.ok(ctx.tests.includes('apps/api/test/booking-service.test.ts'));
  assert.ok(ctx.endpoints.some((e) => e.path === '/bookings/:id/cancel'));
  assert.ok(ctx.tables.some((t) => t.name === 'bookings' && t.usedBy.includes('apps/api/src/analytics/report.ts')));
  assert.ok(ctx.integrations.includes('Email delivery'));
});

test('incremental + commit-bound: only changed blobs are re-parsed', async () => {
  const repo = bookingRepo();
  const cacheDir = mkdtempSync(join(tmpdir(), 'pi-cache-'));
  const a = await buildIndex(repo, { testGlobs: TESTS, cacheDir });
  assert.equal(a.stats.reused, 0);
  const b = await buildIndex(repo, { testGlobs: TESTS, cacheDir });
  assert.equal(b.stats.parsed, 0);
  writeFileSync(join(repo, 'apps/api/src/pool.ts'), 'export const pool = { query: async () => ({}) };\nexport const extra = 1;\n');
  const dirty = await buildIndex(repo, { testGlobs: TESTS, cacheDir });
  assert.equal(dirty.stats.parsed, 1, 'uncommitted change is seen');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'x');
  const c = await buildIndex(repo, { testGlobs: TESTS, cacheDir });
  assert.equal(c.stats.parsed, 0, 'same blob after commit -> cached');
  assert.notEqual(c.commit, a.commit);
});

test('blast radius: changed exported symbol -> consumers the diff did not touch', async () => {
  const repo = bookingRepo();
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  writeFileSync(
    join(repo, 'apps/api/src/services/booking-service.ts'),
    "import { prisma, CANCEL_WINDOW_HOURS } from '@acme/db';\nimport { notify } from './notifications';\n\nexport function canCancel(startsAt: Date, now: Date): boolean {\n  return startsAt.getTime() - now.getTime() > CANCEL_WINDOW_HOURS * 3600_000; // strict now\n}\n\nexport async function cancelBooking(id: string) {\n  const b = await prisma.booking.update({ where: { id }, data: { status: 'cancelled' } });\n  await notify(b.staffId, 'Booking cancelled');\n  return b;\n}\n",
  );
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'strict');
  const idx = await buildIndex(repo, { testGlobs: TESTS });
  const hunks = parseHunks(git(repo, 'diff', '-U0', `${base}..HEAD`));
  const rep = consumersOfChange(idx, hunks, ['apps/api/src/services/booking-service.ts']);
  assert.equal(rep.length, 1);
  assert.equal(rep[0]!.symbol.symbol, 'canCancel');
  assert.ok(rep[0]!.consumers.some((c) => c.file === 'apps/api/src/admin.ts' && !c.changed));
});

test('project knowledge: delivered features are recalled for related future work', () => {
  const k = recordFeature(undefined, 'p', {
    taskId: 'TASK-1', title: 'Booking cancellation', prompt: 'Client can cancel a booking', completedAt: new Date().toISOString(), commit: 'abc',
    requirements: [{ id: 'REQ-02', description: 'Cannot cancel within 12 hours of start', acceptanceCriteria: ['returns 409'] }],
    assumptions: [], decisions: ['12h window confirmed by owner'], files: ['apps/api/src/services/booking-service.ts'], tests: [], endpoints: ['POST /bookings/:id/cancel'], tables: ['bookings'], terms: [],
  });
  assert.equal(relevantKnowledge(k, { terms: ['refund for cancelled booking'], files: [] })[0]?.taskId, 'TASK-1');
  assert.equal(relevantKnowledge(k, { terms: ['unrelated'], files: ['apps/api/src/services/booking-service.ts'] })[0]?.taskId, 'TASK-1');
  assert.equal(relevantKnowledge(k, { terms: ['invoice pdf export'], files: [] }).length, 0);
});

test('orchestrator: knowledge is recorded on DONE and fed to the next task; reviewer gets the blast radius', async () => {
  const e = await setup();
  const t1 = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Add a subtract function to the math module' })).id);
  assert.equal(t1.state, 'DONE', t1.stopReason ?? '');
  const k = (await e.store.getKnowledge<any>('sample'))!;
  assert.equal(k.features[0].taskId, t1.id);
  assert.ok(k.features[0].files.includes('src/math.js'));

  const t2 = await e.orch.run((await e.orch.createTask({ projectId: 'sample', prompt: 'Change math subtract to also accept strings' })).id);
  assert.equal(t2.state, 'DONE', t2.stopReason ?? '');
  const prompts = e.runner.calls.slice(6);
  const spec = prompts.find((c) => c.role === 'architect' && c.prompt.includes(': specification'))!.prompt;
  assert.match(spec, /Previously delivered related features/);
  assert.match(spec, new RegExp(t1.id));
  assert.match(spec, /Related code found by the system/);
  const review = prompts.find((c) => c.role === 'reviewer')!.prompt;
  assert.match(review, /Blast radius computed by the system/);
  assert.match(review, /src\/math\.js `subtract`/);
  assert.ok((await e.store.listEvents(t2.id)).some((x) => x.type === 'index_built' && (x.data.reused as number) > 0), 'index cache reused across tasks');
});
