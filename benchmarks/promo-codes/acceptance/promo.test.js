// Hidden acceptance tests: never shown to any agent, copied in only after the run.
import test from 'node:test';
import assert from 'node:assert';
import * as m from '../src/cart.js';

const now = new Date('2030-01-01T00:00:00Z');
const cart = () => ({ items: [{ productId: 'a', price: 100, qty: 1 }, { productId: 'b', price: 33.33, qty: 3 }] });
const promo = (o = {}) => ({ code: 'X', percent: 10, maxUses: 5, used: 0, expiresAt: new Date('2030-02-01T00:00:00Z'), ...o });

test('error classes exported', () => {
  for (const k of ['PromoExpiredError', 'PromoLimitError', 'PromoNotApplicableError']) assert.equal(typeof m[k], 'function', k);
});
test('10% on everything, rounded to cents', () => {
  assert.equal(m.total(m.applyPromo(cart(), promo(), now)), 179.99);
});
test('only listed products are discounted', () => {
  assert.equal(m.total(m.applyPromo(cart(), promo({ productIds: ['a'] }), now)), 189.99);
});
test('expired', () => assert.throws(() => m.applyPromo(cart(), promo({ expiresAt: new Date('2029-12-31T00:00:00Z') }), now), m.PromoExpiredError));
test('limit reached', () => assert.throws(() => m.applyPromo(cart(), promo({ used: 5 }), now), m.PromoLimitError));
test('not applicable', () => assert.throws(() => m.applyPromo(cart(), promo({ productIds: ['zzz'] }), now), m.PromoNotApplicableError));
test('input cart is not mutated', () => {
  const c = cart();
  m.applyPromo(c, promo(), now);
  assert.equal(m.total(c), 199.99);
});
