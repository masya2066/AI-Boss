import test from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/memory.js';
import { addBook } from '../src/services/catalog.js';
import { addMember } from '../src/services/members.js';
import { borrow, returnBook, MAX_ACTIVE_LOANS } from '../src/services/loans.js';

test('borrow and return', () => {
  const db = createDb();
  const b = addBook(db, { title: 'Dune', author: 'Herbert', copies: 1 });
  const m = addMember(db, { name: 'Ann', email: 'ann@x.io' });
  const loan = borrow(db, { memberId: m.id, bookId: b.id });
  assert.throws(() => borrow(db, { memberId: m.id, bookId: b.id }), /no copies/);
  returnBook(db, { loanId: loan.id });
  assert.ok(borrow(db, { memberId: m.id, bookId: b.id }));
});

test('active loan limit', () => {
  const db = createDb();
  const m = addMember(db, { name: 'Bob', email: 'bob@x.io' });
  for (let i = 0; i < MAX_ACTIVE_LOANS; i++) borrow(db, { memberId: m.id, bookId: addBook(db, { title: `t${i}` }).id });
  assert.throws(() => borrow(db, { memberId: m.id, bookId: addBook(db, { title: 'x' }).id }), /limit/);
});
