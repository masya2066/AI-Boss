import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/server.js';

test('http: books and loans', async () => {
  const { server } = createApp();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', body: JSON.stringify(b) });
  try {
    const book = await (await post('/books', { title: 'Dune', copies: 1 })).json();
    const m = await (await post('/members', { name: 'A', email: 'a@x.io' })).json();
    assert.equal((await post('/loans', { memberId: m.id, bookId: book.id })).status, 201);
    assert.equal((await post('/loans', { memberId: m.id, bookId: book.id })).status, 400);
    assert.equal((await (await fetch(base + '/books')).json())[0].available, 0);
  } finally {
    server.close();
  }
});
