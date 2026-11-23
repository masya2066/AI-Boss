import type { Store } from './store';
import { MemoryStore } from './memory-store';
import { PgStore } from './pg-store';

export type { Store } from './store';
export { MemoryStore } from './memory-store';
export { PgStore } from './pg-store';

/** DATABASE_URL -> PostgreSQL, otherwise a JSON-file store at `fallbackFile`. */
export async function openStore(opts: { databaseUrl?: string; fallbackFile?: string } = {}): Promise<Store> {
  const store: Store = opts.databaseUrl ? new PgStore(opts.databaseUrl) : new MemoryStore(opts.fallbackFile);
  await store.init();
  return store;
}
