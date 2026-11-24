import { createServer } from 'node:http';
import { createDb } from '../db/memory.js';
import { addBook, listBooks } from '../services/catalog.js';
import { addMember } from '../services/members.js';
import { borrow, returnBook } from '../services/loans.js';
import { createMailer } from '../notify/email.js';

async function body(req) {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

/** Routes: [method, regex, handler(ctx, params, body)] */
export function createApp({ db = createDb(), mailer = createMailer(), clock = () => new Date() } = {}) {
  const ctx = { db, mailer, clock };
  const routes = [
    ['GET', /^\/books$/, (c) => listBooks(c.db)],
    ['POST', /^\/books$/, (c, _p, b) => addBook(c.db, b)],
    ['POST', /^\/members$/, (c, _p, b) => addMember(c.db, b)],
    ['POST', /^\/loans$/, (c, _p, b) => borrow(c.db, { ...b, now: c.clock() })],
    ['POST', /^\/loans\/([^/]+)\/return$/, (c, p) => returnBook(c.db, { loanId: p[0], now: c.clock() })],
  ];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    for (const [method, re, handler] of routes) {
      const m = url.pathname.match(re);
      if (req.method !== method || !m) continue;
      try {
        const out = await handler(ctx, m.slice(1), await body(req));
        res.writeHead(method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(/unknown/.test(e.message) ? 404 : 400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }
    res.writeHead(404).end();
  });
  return { server, ctx };
}

if (import.meta.url === `file://${process.argv[1]}`) createApp().server.listen(3000);
