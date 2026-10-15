import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCoupon, cartTotal } from '../src/cart.js';

test('cartTotal sums line items', () => {
  assert.equal(cartTotal([{ price: 10, quantity: 2 }, { price: 5, quantity: 1 }]), 25);
});

test('applyCoupon applies an unexpired coupon', () => {
  assert.equal(applyCoupon(100, { percentOff: 10, expiresAt: '2999-01-01' }, new Date('2026-01-01')), 90);
});

test('applyCoupon ignores an expired coupon', () => {
  assert.equal(applyCoupon(100, { percentOff: 10, expiresAt: '2020-01-01' }, new Date('2026-01-01')), 100);
});
