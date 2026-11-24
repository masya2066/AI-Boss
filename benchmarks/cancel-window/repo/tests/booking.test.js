import test from 'node:test';
import assert from 'node:assert';
import { createBooking, cancelBooking } from '../src/booking.js';

test('cancel far in advance', () => {
  const b = createBooking('1', '2030-01-02T10:00:00Z');
  assert.equal(cancelBooking(b, new Date('2030-01-01T00:00:00Z')).status, 'cancelled');
});
