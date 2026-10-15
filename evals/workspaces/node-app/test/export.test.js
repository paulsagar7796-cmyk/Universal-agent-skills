import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportOrders } from '../src/export.js';

test('exportOrders writes CSV', () => {
  assert.equal(exportOrders([{ id: 1, customer: 'ana', total: 12 }]), 'id,customer,total\n1,ana,12');
});
