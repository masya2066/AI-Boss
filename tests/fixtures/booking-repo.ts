import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd }).toString();

/** Booking monorepo: Prisma + SQL + Express + NestJS + Next.js + Python + tsconfig paths + barrels. */
export function bookingRepo() {
  const repo = join(mkdtempSync(join(tmpdir(), 'pi-')), 'repo');
  const w = (p: string, s: string) => (mkdirSync(dirname(join(repo, p)), { recursive: true }), writeFileSync(join(repo, p), s));
  w('package.json', JSON.stringify({ name: 'acme', private: true, workspaces: ['packages/*', 'apps/*'] }));
  w('tsconfig.json', '{ // comments are fine\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["apps/web/src/*"] } } }');
  w('packages/db/package.json', JSON.stringify({ name: '@acme/db', main: 'src/index.ts' }));
  w('packages/db/src/index.ts', 'export const prisma = {} as any;\nexport const CANCEL_WINDOW_HOURS = 12;\n');
  w('prisma/schema.prisma', 'model Booking {\n  id String @id\n  startsAt DateTime\n  status String\n  staff Staff @relation(fields: [staffId], references: [id])\n  staffId String\n  @@map("bookings")\n}\n\nmodel Staff {\n  id String @id\n  name String\n  bookings Booking[]\n}\n\ndatasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n');
  w('migrations/001_init.sql', 'CREATE TABLE bookings (\n  id uuid primary key,\n  starts_at timestamptz not null,\n  staff_id uuid references staff(id)\n);\nALTER TABLE bookings ADD COLUMN cancelled_at timestamptz;\n');
  w('apps/api/package.json', JSON.stringify({ name: '@acme/api' }));
  w('apps/api/src/services/booking-service.ts', "import { prisma, CANCEL_WINDOW_HOURS } from '@acme/db';\nimport { notify } from './notifications';\n\nexport function canCancel(startsAt: Date, now: Date): boolean {\n  return startsAt.getTime() - now.getTime() >= CANCEL_WINDOW_HOURS * 3600_000;\n}\n\nexport async function cancelBooking(id: string) {\n  const b = await prisma.booking.update({ where: { id }, data: { status: 'cancelled' } });\n  await notify(b.staffId, 'Booking cancelled');\n  return b;\n}\n");
  w('apps/api/src/services/notifications.ts', "import nodemailer from 'nodemailer';\nimport { pool } from '../pool';\nexport async function notify(to: string, text: string) {\n  const host = process.env.SMTP_HOST;\n  await pool.query('SELECT email FROM bookings b JOIN staff s ON s.id = b.staff_id WHERE b.id = $1', [to]);\n  return nodemailer.createTransport({ host }).sendMail({ to, text });\n}\n");
  w('apps/api/src/pool.ts', 'export const pool = { query: async (..._a: unknown[]) => ({}) };\n');
  w('apps/api/src/analytics/report.ts', "import knex from 'knex';\nconst db = knex({});\nexport async function weeklyCancellations() {\n  await fetch('https://api.mixpanel.com/track');\n  return db('bookings').where('status', 'cancelled').count();\n}\n");
  w('apps/api/src/routes/bookings.ts', "import { Router } from 'express';\nimport { cancelBooking } from '../services/booking-service';\nexport const router = Router();\nrouter.post('/bookings/:id/cancel', async (req, res) => res.json(await cancelBooking(req.params.id)));\nrouter.get('/bookings/:id', async (_req, res) => res.json({}));\n");
  w('apps/api/src/index.ts', "export * from './services/booking-service';\nexport { router } from './routes/bookings';\n");
  w('apps/api/src/admin.ts', "import { canCancel } from './index';\nexport const adminCanCancel = (d: Date) => canCancel(d, new Date());\n");
  w('apps/api/src/staff.controller.ts', "import { Controller, Get } from '@nestjs/common';\n@Controller('staff')\nexport class StaffController {\n  @Get(':id')\n  find() { return {}; }\n}\n");
  w('apps/api/test/booking-service.test.ts', "import { test } from 'node:test';\nimport { canCancel } from '../src/services/booking-service';\ntest('cannot cancel within 12 hours', () => { canCancel(new Date(), new Date()); });\n");
  w('apps/web/package.json', JSON.stringify({ name: '@acme/web' }));
  w('apps/web/src/lib/api.ts', "export const cancel = (id: string) => fetch(`/api/bookings/${id}/cancel`, { method: 'POST' });\n");
  w('apps/web/src/app/bookings/[id]/page.tsx', "import { cancel } from '@/lib/api';\nexport default function Page() { return <button onClick={() => cancel('1')}>Cancel</button>; }\n");
  w('apps/web/src/app/api/bookings/route.ts', 'export async function GET() { return new Response("[]"); }\n');
  w('worker/db.py', 'import os\n\ndef get_conn():\n    return os.environ.get("DATABASE_URL")\n');
  w('worker/jobs.py', 'from .db import get_conn\nfrom fastapi import FastAPI\napp = FastAPI()\n\n@app.get("/health")\ndef health():\n    return {"ok": True}\n\ndef test_health():\n    assert health()\n');
  w('worker/__init__.py', '');
  w('.github/workflows/ci.yml', 'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n        env:\n          TOKEN: ${{ secrets.NPM_TOKEN }}\n');
  w('.env.example', 'SMTP_HOST=\nDATABASE_URL=\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return repo;
}

