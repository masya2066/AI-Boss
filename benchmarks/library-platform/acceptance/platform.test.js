// Hidden acceptance tests for tiers, renewals, fines, audit, search and their interactions.
// Written from the task contract only; copied in after the run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/server.js';
import { createMailer } from '../src/notify/email.js';

const H = 3600_000;
const D = 24 * H;

async function world() {
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
    return { status: r.status, body: json, headers: r.headers };
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
  w.book = async (title, o = {}) => (await w.post('/books', { title, author: o.author ?? 'Anon', copies: o.copies ?? 1 })).body;
  w.member = async (name, tier) => (await w.post('/members', { name, email: `${name}@lib.test`, ...(tier ? { tier } : {}) })).body;
  w.borrow = (m, b) => w.post('/loans', { memberId: m.id, bookId: b.id });
  w.ret = (loan) => w.post(`/loans/${loan.id}/return`);
  w.renew = (loan) => w.post(`/loans/${loan.id}/renew`);
  w.fines = async (m) => (await w.get(`/members/${m.id}/fines`)).body;
  w.audit = async (qs = '') => (await w.get(`/audit${qs}`)).body;
  return w;
}
const ok = (r, msg) => assert.ok(r.status >= 200 && r.status < 300, `${msg ?? ''} ${r.status} ${JSON.stringify(r.body)}`);

// ----------------------------------------------------------------- tiers --
test('tiers: default basic, premium accepted, unknown tier -> 400', async () => {
  const w = await world();
  try {
    assert.equal((await w.member('ann')).tier, 'basic');
    assert.equal((await w.member('bob', 'premium')).tier, 'premium');
    assert.equal((await w.post('/members', { name: 'x', email: 'x@lib.test', tier: 'gold' })).status, 400);
  } finally {
    await w.close();
  }
});

test('tiers: loan period 14 days for basic, 28 days for premium', async () => {
  const w = await world();
  try {
    const b1 = await w.book('One');
    const b2 = await w.book('Two');
    const basic = (await w.borrow(await w.member('ann'), b1)).body;
    const prem = (await w.borrow(await w.member('bob', 'premium'), b2)).body;
    assert.equal(Date.parse(basic.dueAt), w.now.getTime() + 14 * D);
    assert.equal(Date.parse(prem.dueAt), w.now.getTime() + 28 * D);
  } finally {
    await w.close();
  }
});

test('tiers: active loan limit 3 for basic, 6 for premium (400 beyond)', async () => {
  const w = await world();
  try {
    const ann = await w.member('ann');
    const bob = await w.member('bob', 'premium');
    for (let i = 0; i < 3; i++) ok(await w.borrow(ann, await w.book(`A${i}`)));
    assert.equal((await w.borrow(ann, await w.book('A3'))).status, 400);
    for (let i = 0; i < 6; i++) ok(await w.borrow(bob, await w.book(`B${i}`)));
    assert.equal((await w.borrow(bob, await w.book('B6'))).status, 400);
  } finally {
    await w.close();
  }
});

// -------------------------------------------------------------- renewals --
test('renewal extends dueAt by the tier period from the current dueAt and counts renewals', async () => {
  const w = await world();
  try {
    const loan = (await w.borrow(await w.member('ann'), await w.book('Dune'))).body;
    assert.equal(loan.renewals, 0);
    w.advance(3 * D);
    const r1 = await w.renew(loan);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.renewals, 1);
    assert.equal(Date.parse(r1.body.dueAt), Date.parse(loan.dueAt) + 14 * D);
    const r2 = await w.renew(loan);
    assert.equal(Date.parse(r2.body.dueAt), Date.parse(loan.dueAt) + 28 * D);
    assert.equal((await w.renew(loan)).status, 409, 'third renewal');
  } finally {
    await w.close();
  }
});

test('premium renewal adds 28 days', async () => {
  const w = await world();
  try {
    const loan = (await w.borrow(await w.member('bob', 'premium'), await w.book('Dune'))).body;
    const r = await w.renew(loan);
    assert.equal(Date.parse(r.body.dueAt), Date.parse(loan.dueAt) + 28 * D);
  } finally {
    await w.close();
  }
});

test('renewal refused: unknown (404), returned, overdue, or someone is waiting (409)', async () => {
  const w = await world();
  try {
    assert.equal((await w.post('/loans/nope/renew')).status, 404);
    const ann = await w.member('ann');
    const bob = await w.member('bob');
    const b1 = await w.book('One');
    const l1 = (await w.borrow(ann, b1)).body;
    ok(await w.ret(l1));
    assert.equal((await w.renew(l1)).status, 409, 'returned');
    const l2 = (await w.borrow(ann, b1)).body;
    ok(await w.post(`/books/${b1.id}/reservations`, { memberId: bob.id }));
    assert.equal((await w.renew(l2)).status, 409, 'someone waiting');
    const b2 = await w.book('Two');
    const l3 = (await w.borrow(bob, b2)).body;
    w.advance(14 * D + 60_000);
    assert.equal((await w.renew(l3)).status, 409, 'overdue');
  } finally {
    await w.close();
  }
});

test('renewal allowed again after the waiting reservation is cancelled', async () => {
  const w = await world();
  try {
    const ann = await w.member('ann');
    const bob = await w.member('bob');
    const b = await w.book('One');
    const l = (await w.borrow(ann, b)).body;
    const r = (await w.post(`/books/${b.id}/reservations`, { memberId: bob.id })).body;
    assert.equal((await w.renew(l)).status, 409);
    ok(await w.del(`/reservations/${r.id}`));
    assert.equal((await w.renew(l)).status, 200);
  } finally {
    await w.close();
  }
});

// ----------------------------------------------------------------- fines --
test('returning on time creates no fine; late return: 25 cents per started day', async () => {
  const w = await world();
  try {
    const ann = await w.member('ann');
    const l1 = (await w.borrow(ann, await w.book('One'))).body;
    w.advance(14 * D);
    ok(await w.ret(l1));
    assert.deepEqual(await w.fines(ann), { fines: [], balance: 0 });
    const l2 = (await w.borrow(ann, await w.book('Two'))).body;
    w.advance(14 * D + 2 * D + H); // 2 days and 1 hour late -> 3 started days
    ok(await w.ret(l2));
    const f = await w.fines(ann);
    assert.equal(f.balance, 75);
    assert.equal(f.fines.length, 1);
    assert.equal(f.fines[0].amount, 75);
    assert.equal(f.fines[0].loanId, l2.id);
    assert.equal(f.fines[0].paid, false);
  } finally {
    await w.close();
  }
});

test('a fine is capped at 1000 cents per loan', async () => {
  const w = await world();
  try {
    const ann = await w.member('ann');
    const l = (await w.borrow(ann, await w.book('One'))).body;
    w.advance(14 * D + 100 * D);
    ok(await w.ret(l));
    assert.equal((await w.fines(ann)).balance, 1000);
  } finally {
    await w.close();
  }
});

test('payments: oldest first, partial payment reduces amount, validation', async () => {
  const w = await world();
  try {
    const ann = await w.member('ann');
    const l1 = (await w.borrow(ann, await w.book('One'))).body;
    const l2 = (await w.borrow(ann, await w.book('Two'))).body;
    w.advance(15 * D); // 1 day late each
    ok(await w.ret(l1));
    w.advance(D); // second returned 2 days late
    ok(await w.ret(l2));
    assert.equal((await w.fines(ann)).balance, 75);
    assert.equal((await w.post(`/members/${ann.id}/payments`, { amount: 0 })).status, 400);
    assert.equal((await w.post(`/members/${ann.id}/payments`, { amount: 76 })).status, 400);
    const p = await w.post(`/members/${ann.id}/payments`, { amount: 40 });
    assert.equal(p.status, 200);
    assert.equal(p.body.balance, 35);
    const f = await w.fines(ann);
    const byLoan = Object.fromEntries(f.fines.map((x) => [x.loanId, x]));
    assert.equal(byLoan[l1.id].paid, true, 'oldest fine paid first');
    assert.equal(byLoan[l2.id].paid, false);
    assert.equal(byLoan[l2.id].amount, 35);
    assert.equal(f.balance, 35);
  } finally {
    await w.close();
  }
});

test('balance >= 500 blocks borrowing and reserving with 403; paying it down unblocks', async () => {
  const w = await world();
  try {
    const ann = await w.member('ann');
    const bob = await w.member('bob');
    const l = (await w.borrow(ann, await w.book('One'))).body;
    w.advance(14 * D + 20 * D); // 20 days late -> 500
    ok(await w.ret(l));
    assert.equal((await w.fines(ann)).balance, 500);
    const free = await w.book('Free');
    assert.equal((await w.borrow(ann, free)).status, 403);
    const taken = await w.book('Taken');
    ok(await w.borrow(bob, taken));
    assert.equal((await w.post(`/books/${taken.id}/reservations`, { memberId: ann.id })).status, 403);
    ok(await w.post(`/members/${ann.id}/payments`, { amount: 1 }));
    assert.equal((await w.borrow(ann, free)).status, 201, 'balance 499 is allowed');
  } finally {
    await w.close();
  }
});

test('a member with a blocking balance cannot collect a copy held for them', async () => {
  const w = await world();
  try {
    const ann = await w.member('ann');
    const bob = await w.member('bob');
    const dune = await w.book('Dune');
    const old = (await w.borrow(ann, await w.book('Old'))).body;
    const lb = (await w.borrow(bob, dune)).body;
    ok(await w.post(`/books/${dune.id}/reservations`, { memberId: ann.id }));
    w.advance(14 * D + 30 * D);
    ok(await w.ret(old)); // ann: 750 cents
    ok(await w.ret(lb)); // copy held for ann (bob pays his own fine, irrelevant)
    const mine = (await w.get(`/members/${ann.id}/reservations`)).body;
    assert.equal(mine[0].status, 'held');
    assert.equal((await w.borrow(ann, dune)).status, 403);
    assert.equal((await w.get(`/members/${ann.id}/reservations`)).body[0].status, 'held', 'hold kept');
  } finally {
    await w.close();
  }
});

test('late return of a reserved book: fine for the borrower AND hold for the next member', async () => {
  const w = await world();
  try {
    const ann = await w.member('ann');
    const bob = await w.member('bob');
    const dune = await w.book('Dune');
    const l = (await w.borrow(ann, dune)).body;
    ok(await w.post(`/books/${dune.id}/reservations`, { memberId: bob.id }));
    w.advance(14 * D + 4 * D);
    ok(await w.ret(l));
    assert.equal((await w.fines(ann)).balance, 100);
    assert.equal((await w.get(`/members/${bob.id}/reservations`)).body[0].status, 'held');
    assert.equal(w.mailer.outbox.filter((m) => m.to === 'bob@lib.test').length, 1);
  } finally {
    await w.close();
  }
});

// ----------------------------------------------------------------- audit --
test('audit: every change is recorded in order with ids; seq is 1, 2, 3…', async () => {
  const w = await world();
  try {
    const ann = await w.member('ann');
    const b = await w.book('Dune');
    const l = (await w.borrow(ann, b)).body;
    ok(await w.ret(l));
    const { items, next } = await w.audit();
    assert.equal(next, null);
    assert.deepEqual(items.map((x) => x.seq), items.map((_, i) => i + 1));
    assert.deepEqual(items.map((x) => x.action), ['member.add', 'book.add', 'loan.borrow', 'loan.return']);
    const borrow = items[2];
    assert.equal(borrow.memberId, ann.id);
    assert.equal(borrow.bookId, b.id);
    assert.equal(borrow.loanId, l.id);
    assert.ok(!Number.isNaN(Date.parse(borrow.at)));
  } finally {
    await w.close();
  }
});

test('audit: failed requests are not recorded', async () => {
  const w = await world();
  try {
    const ann = await w.member('ann');
    await w.post('/members', { name: 'x', email: 'bad' });
    await w.post('/loans', { memberId: ann.id, bookId: 'nope' });
    assert.deepEqual((await w.audit()).items.map((x) => x.action), ['member.add']);
  } finally {
    await w.close();
  }
});

test('audit: system events — hold, expire, fine, fulfil — are recorded too', async () => {
  const w = await world();
  try {
    const ann = await w.member('ann');
    const bob = await w.member('bob');
    const cid = await w.member('cid');
    const dune = await w.book('Dune');
    const l = (await w.borrow(ann, dune)).body;
    const rb = (await w.post(`/books/${dune.id}/reservations`, { memberId: bob.id })).body;
    const rc = (await w.post(`/books/${dune.id}/reservations`, { memberId: cid.id })).body;
    w.advance(15 * D);
    ok(await w.ret(l)); // 1 day late -> fine; hold for bob
    w.advance(48 * H); // bob's hold expires -> cid
    await w.get('/books');
    ok(await w.borrow(cid, dune)); // fulfils cid's reservation
    const acts = (await w.audit('?limit=200')).items;
    const find = (a, pred = () => true) => acts.find((x) => x.action === a && pred(x));
    assert.ok(find('fine.create', (x) => x.memberId === ann.id && x.loanId === l.id), 'fine.create');
    assert.ok(find('reservation.hold', (x) => x.reservationId === rb.id), 'hold for bob');
    assert.ok(find('reservation.expire', (x) => x.reservationId === rb.id), 'bob expired');
    assert.ok(find('reservation.hold', (x) => x.reservationId === rc.id), 'hold for cid');
    assert.ok(find('reservation.fulfil', (x) => x.reservationId === rc.id), 'cid fulfilled');
    const seqs = acts.map((x) => x.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  } finally {
    await w.close();
  }
});

test('audit: filters by member, book and action; payments and renewals are recorded', async () => {
  const w = await world();
  try {
    const ann = await w.member('ann');
    const bob = await w.member('bob');
    const b1 = await w.book('One');
    const b2 = await w.book('Two');
    const l1 = (await w.borrow(ann, b1)).body;
    ok(await w.borrow(bob, b2));
    ok(await w.renew(l1));
    w.advance(30 * D);
    ok(await w.ret(l1));
    ok(await w.post(`/members/${ann.id}/payments`, { amount: 10 }));
    const annItems = (await w.audit(`?memberId=${ann.id}`)).items;
    assert.ok(annItems.length >= 5 && annItems.every((x) => x.memberId === ann.id));
    assert.ok(annItems.some((x) => x.action === 'loan.renew' && x.loanId === l1.id));
    assert.ok(annItems.some((x) => x.action === 'payment'));
    const b2Items = (await w.audit(`?bookId=${b2.id}`)).items;
    assert.deepEqual(b2Items.map((x) => x.action), ['book.add', 'loan.borrow']);
    const borrows = (await w.audit('?action=loan.borrow')).items;
    assert.equal(borrows.length, 2);
  } finally {
    await w.close();
  }
});

test('audit: pagination with after/limit/next; limit capped at 200', async () => {
  const w = await world();
  try {
    for (let i = 0; i < 7; i++) await w.book(`B${i}`);
    const p1 = await w.audit('?limit=3');
    assert.deepEqual(p1.items.map((x) => x.seq), [1, 2, 3]);
    assert.equal(p1.next, 3);
    const p2 = await w.audit(`?limit=3&after=${p1.next}`);
    assert.deepEqual(p2.items.map((x) => x.seq), [4, 5, 6]);
    const p3 = await w.audit(`?limit=3&after=${p2.next}`);
    assert.deepEqual(p3.items.map((x) => x.seq), [7]);
    assert.equal(p3.next, null);
    assert.equal((await w.audit()).items.length, 7, 'default limit 50');
    for (let i = 7; i < 230; i++) await w.book(`C${i}`);
    const big = await w.audit('?limit=1000');
    assert.equal(big.items.length, 200);
    assert.equal(big.next, 200);
  } finally {
    await w.close();
  }
});

// ---------------------------------------------------------------- search --
async function shelf(w) {
  const a = await w.book('Emma', { author: 'Jane Austen' });
  const b = await w.book('Dune', { author: 'Frank Herbert' });
  const c = await w.book('Persuasion', { author: 'Jane Austen' });
  const d = await w.book('Children of Dune', { author: 'Frank Herbert' });
  const e = await w.book('Austerlitz', { author: 'W. G. Sebald' });
  return { a, b, c, d, e };
}

test('search: GET /books without params is still an array, sorted by title, with X-Total-Count', async () => {
  const w = await world();
  try {
    await shelf(w);
    const r = await w.get('/books');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
    assert.deepEqual(r.body.map((b) => b.title), ['Austerlitz', 'Children of Dune', 'Dune', 'Emma', 'Persuasion']);
    assert.equal(r.headers.get('x-total-count'), '5');
    assert.ok(r.body.every((b) => typeof b.available === 'number'));
  } finally {
    await w.close();
  }
});

test('search: q matches title or author case-insensitively; author is exact (case-insensitive)', async () => {
  const w = await world();
  try {
    await shelf(w);
    assert.deepEqual((await w.get('/books?q=dune')).body.map((b) => b.title), ['Children of Dune', 'Dune']);
    assert.deepEqual((await w.get('/books?q=AUST')).body.map((b) => b.title), ['Austerlitz', 'Emma', 'Persuasion']);
    assert.deepEqual((await w.get('/books?author=jane%20austen')).body.map((b) => b.title), ['Emma', 'Persuasion']);
    assert.deepEqual((await w.get('/books?author=Jane')).body, []);
  } finally {
    await w.close();
  }
});

test('search: available=true hides lent and held copies; filters combine', async () => {
  const w = await world();
  try {
    const { b, c } = await shelf(w);
    const ann = await w.member('ann');
    const bob = await w.member('bob');
    const l = (await w.borrow(ann, b)).body; // Dune out
    ok(await w.borrow(ann, c)); // Persuasion out
    ok(await w.post(`/books/${b.id}/reservations`, { memberId: bob.id }));
    ok(await w.ret(l)); // Dune held for bob -> still not available
    const r = await w.get('/books?available=true');
    assert.deepEqual(r.body.map((x) => x.title), ['Austerlitz', 'Children of Dune', 'Emma']);
    assert.equal(r.headers.get('x-total-count'), '3');
    assert.deepEqual((await w.get('/books?available=true&author=jane%20austen')).body.map((x) => x.title), ['Emma']);
  } finally {
    await w.close();
  }
});

test('search: pagination with page/limit (limit capped at 100), total before paging', async () => {
  const w = await world();
  try {
    for (let i = 0; i < 25; i++) await w.book(`T${String(i).padStart(2, '0')}`);
    const p1 = await w.get('/books');
    assert.equal(p1.body.length, 20, 'default limit 20');
    assert.equal(p1.headers.get('x-total-count'), '25');
    const p2 = await w.get('/books?page=2&limit=10');
    assert.deepEqual(p2.body.map((x) => x.title), ['T10', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'T17', 'T18', 'T19']);
    assert.deepEqual((await w.get('/books?page=3&limit=10')).body.map((x) => x.title), ['T20', 'T21', 'T22', 'T23', 'T24']);
    assert.deepEqual((await w.get('/books?page=9&limit=10')).body, []);
    for (let i = 25; i < 130; i++) await w.book(`T${i}`);
    assert.equal((await w.get('/books?limit=500')).body.length, 100);
  } finally {
    await w.close();
  }
});

test('search: equal titles are ordered by id', async () => {
  const w = await world();
  try {
    const x = await w.book('Same');
    const y = await w.book('Same');
    const r = (await w.get('/books?q=same')).body.map((b) => b.id);
    assert.deepEqual(r, [x.id, y.id].sort());
  } finally {
    await w.close();
  }
});
