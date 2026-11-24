// Hidden acceptance tests: never shown to any agent, copied in only after the run.
import test from 'node:test';
import assert from 'node:assert';
import * as m from '../src/booking.js';

const start = '2030-01-02T12:00:00Z';
const at = (h) => new Date(Date.parse(start) - h * 3600_000);

test('exports error classes', () => {
  assert.equal(typeof m.CancelWindowError, 'function');
  assert.equal(typeof m.AlreadyCancelledError, 'function');
});
test('11h59m before start -> CancelWindowError', () => {
  assert.throws(() => m.cancelBooking(m.createBooking('a', start), new Date(at(12).getTime() + 60_000)), m.CancelWindowError);
});
test('exactly 12h before start -> allowed', () => {
  assert.equal(m.cancelBooking(m.createBooking('b', start), at(12)).status, 'cancelled');
});
test('after start -> CancelWindowError', () => {
  assert.throws(() => m.cancelBooking(m.createBooking('c', start), at(-1)), m.CancelWindowError);
});
test('second cancel -> AlreadyCancelledError, status unchanged', () => {
  const b = m.cancelBooking(m.createBooking('d', start), at(48));
  const when = b.cancelledAt;
  assert.throws(() => m.cancelBooking(b, at(47)), m.AlreadyCancelledError);
  assert.equal(b.cancelledAt.getTime(), when.getTime());
});
test('rejected cancel does not mutate the booking', () => {
  const b = m.createBooking('e', start);
  assert.throws(() => m.cancelBooking(b, at(1)));
  assert.equal(b.status, 'active');
});
