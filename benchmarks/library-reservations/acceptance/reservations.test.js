// Hidden acceptance tests: written from the task's HTTP contract only, copied in after the run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/server.js';
import { createMailer } from '../src/notify/email.js';

const H = 3600_000;

async function world({ copies = 1 } = {}) {
  let now = new Date('2026-03-02T10:00:00.000Z');
  const mailer = createMailer();
  const { server } = createApp({ clock: () => now, mailer });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: r.status, body: json };
  };
  const w = {
    mailer,
    call,
    get now() {
      return now;
    },
    advance: (ms) => (now = new Date(now.getTime() + ms)),
    close: () => new Promise((r) => server.close(r)),
    post: (p, b) => call('POST', p, b ?? {}),
    get: (p) => call('GET', p),
    del: (p) => call('DELETE', p),
  };
  w.book = (await w.post('/books', { title: 'Dune', author: 'Herbert', copies })).body;
  w.m = {};
  for (const n of ['ann', 'bob', 'cid', 'dan']) w.m[n] = (await w.post('/members', { name: n, email: `${n}@lib.test` })).body;
  w.borrow = (who, bookId = w.book.id) => w.post('/loans', { memberId: w.m[who].id, bookId });
  w.reserve = (who, bookId = w.book.id) => w.post(`/books/${bookId}/reservations`, { memberId: w.m[who].id });
  w.mine = (who) => w.get(`/members/${w.m[who].id}/reservations`);
  w.available = async () => (await w.get('/books')).body.find((b) => b.id === w.book.id).available;
  w.mails = (who) => mailer.outbox.filter((x) => x.to === `${who}@lib.test`);
  return w;
}

/** All copies on loan to `lenders`; returns their loans. */
async function lent(w, ...lenders) {
  const loans = [];
  for (const who of lenders) {
    const r = await w.borrow(who);
    assert.equal(r.status, 201, `setup borrow by ${who}: ${JSON.stringify(r.body)}`);
    loans.push(r.body);
  }
  return loans;
}

test('reserving while a copy is available is refused with 409', async () => {
  const w = await world();
  try {
    const r = await w.reserve('ann');
    assert.equal(r.status, 409);
    assert.ok(r.body?.error);
  } finally {
    await w.close();
  }
});

test('reserving when all copies are out: 201 waiting with queue positions', async () => {
  const w = await world();
  try {
    await lent(w, 'ann');
    const b = await w.reserve('bob');
    assert.equal(b.status, 201);
    assert.equal(b.body.status, 'waiting');
    assert.equal(b.body.position, 1);
    assert.equal(b.body.bookId, w.book.id);
    assert.equal(b.body.memberId, w.m.bob.id);
    assert.ok(b.body.id);
    const c = await w.reserve('cid');
    assert.equal(c.status, 201);
    assert.equal(c.body.position, 2);
  } finally {
    await w.close();
  }
});

test('unknown book or member -> 404', async () => {
  const w = await world();
  try {
    await lent(w, 'ann');
    assert.equal((await w.post('/books/nope/reservations', { memberId: w.m.bob.id })).status, 404);
    assert.equal((await w.post(`/books/${w.book.id}/reservations`, { memberId: 'nobody' })).status, 404);
    assert.equal((await w.get('/members/nobody/reservations')).status, 404);
    assert.equal((await w.del('/reservations/nope')).status, 404);
  } finally {
    await w.close();
  }
});

test('duplicate active reservation, or reserving a book you hold, -> 409', async () => {
  const w = await world();
  try {
    await lent(w, 'ann');
    assert.equal((await w.reserve('bob')).status, 201);
    assert.equal((await w.reserve('bob')).status, 409, 'same member twice');
    assert.equal((await w.reserve('ann')).status, 409, 'member currently holds the book on loan');
  } finally {
    await w.close();
  }
});

test('GET /members/:id/reservations lists active reservations with current positions', async () => {
  const w = await world();
  try {
    await lent(w, 'ann');
    await w.reserve('bob');
    await w.reserve('cid');
    const c = await w.mine('cid');
    assert.equal(c.status, 200);
    assert.equal(c.body.length, 1);
    assert.equal(c.body[0].status, 'waiting');
    assert.equal(c.body[0].position, 2);
    assert.deepEqual((await w.mine('dan')).body, []);
  } finally {
    await w.close();
  }
});

test('cancelling a waiting reservation moves the queue up; cancelling twice -> 409', async () => {
  const w = await world();
  try {
    await lent(w, 'ann');
    const b = (await w.reserve('bob')).body;
    await w.reserve('cid');
    const d = await w.del(`/reservations/${b.id}`);
    assert.equal(d.status, 200);
    assert.equal(d.body.status, 'cancelled');
    assert.equal((await w.mine('cid')).body[0].position, 1);
    assert.deepEqual((await w.mine('bob')).body, []);
    assert.equal((await w.del(`/reservations/${b.id}`)).status, 409);
  } finally {
    await w.close();
  }
});

test('return with a queue: first in line gets a 48h hold and an email; the copy is not available', async () => {
  const w = await world();
  try {
    const [loan] = await lent(w, 'ann');
    await w.reserve('bob');
    await w.reserve('cid');
    w.advance(2 * H);
    const r = await w.post(`/loans/${loan.id}/return`);
    assert.ok(r.status === 200 || r.status === 201, `return: ${r.status}`);
    const [held] = (await w.mine('bob')).body;
    assert.equal(held.status, 'held');
    assert.equal(Date.parse(held.expiresAt), w.now.getTime() + 48 * H);
    const mails = w.mails('bob');
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /Dune/);
    assert.equal(w.mails('cid').length, 0);
    assert.equal((await w.mine('cid')).body[0].position, 1);
    assert.equal(await w.available(), 0);
  } finally {
    await w.close();
  }
});

test('return without a queue: no email, the copy is available again', async () => {
  const w = await world();
  try {
    const [loan] = await lent(w, 'ann');
    await w.post(`/loans/${loan.id}/return`);
    assert.equal(w.mailer.outbox.length, 0);
    assert.equal(await w.available(), 1);
  } finally {
    await w.close();
  }
});

test('a held copy can be borrowed only by the holder; borrowing fulfils the reservation', async () => {
  const w = await world();
  try {
    const [loan] = await lent(w, 'ann');
    await w.reserve('bob');
    await w.post(`/loans/${loan.id}/return`);
    assert.equal((await w.borrow('cid')).status, 409, 'someone else');
    assert.equal((await w.borrow('ann')).status, 409, 'previous borrower');
    const ok = await w.borrow('bob');
    assert.equal(ok.status, 201);
    assert.deepEqual((await w.mine('bob')).body, [], 'fulfilled is no longer active');
    assert.equal(await w.available(), 0);
  } finally {
    await w.close();
  }
});

test('a hold expires at exactly 48h and passes to the next member with a new 48h and an email', async () => {
  const w = await world();
  try {
    const [loan] = await lent(w, 'ann');
    await w.reserve('bob');
    await w.reserve('cid');
    await w.post(`/loans/${loan.id}/return`);
    w.advance(48 * H - 60_000);
    assert.equal((await w.mine('bob')).body[0]?.status, 'held', 'still held one minute before expiry');
    assert.equal((await w.borrow('cid')).status, 409);
    w.advance(60_000);
    // any request processes expiry
    const cid = (await w.mine('cid')).body;
    assert.equal(cid[0].status, 'held');
    assert.equal(Date.parse(cid[0].expiresAt), w.now.getTime() + 48 * H);
    assert.deepEqual((await w.mine('bob')).body, [], 'expired is no longer active');
    assert.equal(w.mails('cid').length, 1);
    assert.match(w.mails('cid')[0].subject, /Dune/);
    assert.equal((await w.borrow('bob')).status, 409, 'expired holder lost the copy');
    assert.equal((await w.borrow('cid')).status, 201);
  } finally {
    await w.close();
  }
});

test('an expired hold with nobody waiting frees the copy for anyone', async () => {
  const w = await world();
  try {
    const [loan] = await lent(w, 'ann');
    await w.reserve('bob');
    await w.post(`/loans/${loan.id}/return`);
    w.advance(49 * H);
    assert.equal(await w.available(), 1);
    assert.equal((await w.borrow('dan')).status, 201);
  } finally {
    await w.close();
  }
});

test('cancelling a held reservation passes the copy to the next member immediately', async () => {
  const w = await world();
  try {
    const [loan] = await lent(w, 'ann');
    const b = (await w.reserve('bob')).body;
    await w.reserve('cid');
    await w.post(`/loans/${loan.id}/return`);
    const d = await w.del(`/reservations/${b.id}`);
    assert.equal(d.status, 200);
    assert.equal(d.body.status, 'cancelled');
    const [c] = (await w.mine('cid')).body;
    assert.equal(c.status, 'held');
    assert.equal(w.mails('cid').length, 1);
    assert.equal((await w.borrow('cid')).status, 201);
  } finally {
    await w.close();
  }
});

test('cancelling the only held reservation frees the copy', async () => {
  const w = await world();
  try {
    const [loan] = await lent(w, 'ann');
    const b = (await w.reserve('bob')).body;
    await w.post(`/loans/${loan.id}/return`);
    await w.del(`/reservations/${b.id}`);
    assert.equal(await w.available(), 1);
    assert.equal((await w.borrow('dan')).status, 201);
  } finally {
    await w.close();
  }
});

test('several copies: each returned copy is held for the next member in order', async () => {
  const w = await world({ copies: 2 });
  try {
    const [l1, l2] = await lent(w, 'ann', 'bob');
    await w.reserve('cid');
    await w.reserve('dan');
    await w.post(`/loans/${l1.id}/return`);
    assert.equal((await w.mine('cid')).body[0].status, 'held');
    assert.equal((await w.mine('dan')).body[0].position, 1);
    await w.post(`/loans/${l2.id}/return`);
    assert.equal((await w.mine('dan')).body[0].status, 'held');
    assert.equal(await w.available(), 0);
  } finally {
    await w.close();
  }
});

test('report: per-book waiting/held counts and the total, only books with active reservations', async () => {
  const w = await world();
  try {
    const other = (await w.post('/books', { title: 'Emma', copies: 1 })).body;
    await w.post('/books', { title: 'Quiet', copies: 1 });
    const [loan] = await lent(w, 'ann');
    await w.post('/loans', { memberId: w.m.dan.id, bookId: other.id });
    await w.reserve('bob');
    await w.reserve('cid');
    await w.reserve('ann', other.id);
    await w.post(`/loans/${loan.id}/return`);
    const r = await w.get('/reports/reservations');
    assert.equal(r.status, 200);
    assert.equal(r.body.totalActive, 3);
    const byId = Object.fromEntries(r.body.books.map((b) => [b.bookId, b]));
    assert.equal(r.body.books.length, 2);
    assert.deepEqual([byId[w.book.id].waiting, byId[w.book.id].held, byId[w.book.id].title], [1, 1, 'Dune']);
    assert.deepEqual([byId[other.id].waiting, byId[other.id].held], [1, 0]);
  } finally {
    await w.close();
  }
});

test('existing behaviour is unchanged: no copies without holds -> 400, loan limit still applies', async () => {
  const w = await world();
  try {
    await lent(w, 'ann');
    const r = await w.borrow('bob');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /no copies available/);
    for (let i = 0; i < 3; i++) {
      const b = (await w.post('/books', { title: `B${i}`, copies: 1 })).body;
      assert.equal((await w.post('/loans', { memberId: w.m.cid.id, bookId: b.id })).status, 201);
    }
    const extra = (await w.post('/books', { title: 'X', copies: 1 })).body;
    assert.equal((await w.post('/loans', { memberId: w.m.cid.id, bookId: extra.id })).status, 400);
  } finally {
    await w.close();
  }
});
