import { PgStore } from './pg-store';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const s = new PgStore(url);
await s.migrate();
await s.close();
console.log('migrations applied');
