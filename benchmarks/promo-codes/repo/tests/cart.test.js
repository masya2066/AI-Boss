import test from 'node:test';
import assert from 'node:assert';
import { total } from '../src/cart.js';

test('total', () => assert.equal(total({ items: [{ productId: 'a', price: 10.5, qty: 2 }] }), 21));
