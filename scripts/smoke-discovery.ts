// Real researcher run (subscription) on the booking fixture with a Russian request:
// checks that searchTerms come back in the code's language and drive the context.
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { bootstrap } from '@devpilot/orchestrator';
import { bookingRepo } from '../tests/fixtures/booking-repo';

process.env.DEVPILOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'dp-smoke-'));
const { store, orchestrator } = await bootstrap({ log: (l) => console.log(l) });
const repo = bookingRepo();
await orchestrator.registerProject({ id: 'booking', repoPath: repo });
const t = await orchestrator.createTask({ projectId: 'booking', prompt: 'Клиент должен иметь возможность отменить запись, но не позднее чем за 12 часов до начала. Сотрудник получает уведомление.' });
await orchestrator.step(t.id); // QUEUED -> DISCOVERY
await orchestrator.step(t.id); // DISCOVERY (real researcher) -> SPECIFICATION
const done = (await store.getTask(t.id))!;
console.log(JSON.stringify({ state: done.state, searchTerms: done.discovery?.searchTerms, relevantFiles: done.discovery?.relevantFiles, cost: done.costUsd.toFixed(2) }, null, 2));
console.log(done.discovery?.context?.split('\n').slice(0, 16).join('\n'));
await orchestrator.cancel(t.id, 'smoke test');
await store.close();
