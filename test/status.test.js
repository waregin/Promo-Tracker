import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseExpiry,
  isExpired,
  isSpent,
  derivePromoStatus,
  isActive,
  countActiveForVendor,
} from '../src/lib/status.js';

const promo = (fields = {}) => ({
  id: 'p',
  vendorId: 'v',
  reusable: false,
  useCount: 0,
  archived: false,
  expiresAt: null,
  expiryConfidence: 'unknown',
  ...fields,
});

test('date-only expiry lasts until the end of that local day', () => {
  const at = parseExpiry('2026-09-12');
  assert.equal(at.getFullYear(), 2026);
  assert.equal(at.getMonth(), 8);
  assert.equal(at.getDate(), 12);
  assert.equal(at.getHours(), 23);
  assert.equal(at.getMinutes(), 59);
});

test('a code expiring today is still usable today', () => {
  const today = promo({ expiresAt: '2026-09-12' });
  assert.equal(isExpired(today, new Date(2026, 8, 12, 0, 1)), false);
  assert.equal(isExpired(today, new Date(2026, 8, 12, 23, 59, 0)), false);
  assert.equal(isExpired(today, new Date(2026, 8, 13, 0, 1)), true);
});

test('unparseable and missing expiry dates never count as expired', () => {
  assert.equal(parseExpiry(null), null);
  assert.equal(parseExpiry(''), null);
  assert.equal(parseExpiry('whenever'), null);
  assert.equal(isExpired(promo({ expiresAt: null })), false);
  assert.equal(isExpired(promo({ expiresAt: 'whenever' })), false);
});

test('spent means a single-use code that was used', () => {
  assert.equal(isSpent(promo({ reusable: false, useCount: 0 })), false);
  assert.equal(isSpent(promo({ reusable: false, useCount: 1 })), true);
  // A reusable code is never spent, however often it is used (spec §3).
  assert.equal(isSpent(promo({ reusable: true, useCount: 9 })), false);
});

test('derived status covers each case', () => {
  const now = new Date(2026, 8, 12);
  assert.equal(derivePromoStatus(promo(), now), 'active');
  assert.equal(derivePromoStatus(promo({ archived: true }), now), 'archived');
  assert.equal(derivePromoStatus(promo({ useCount: 1 }), now), 'spent');
  assert.equal(derivePromoStatus(promo({ expiresAt: '2026-01-01' }), now), 'expired');
  assert.equal(derivePromoStatus(promo({ reusable: true, useCount: 4 }), now), 'active');
  // Archived beats everything; spent beats expired.
  assert.equal(derivePromoStatus(promo({ archived: true, useCount: 3 }), now), 'archived');
  assert.equal(derivePromoStatus(promo({ useCount: 1, expiresAt: '2026-01-01' }), now), 'spent');
});

test('a reusable code stays active past its use count but not past its date', () => {
  const now = new Date(2026, 8, 12);
  assert.equal(isActive(promo({ reusable: true, useCount: 12 }), now), true);
  assert.equal(isActive(promo({ reusable: true, useCount: 12, expiresAt: '2026-08-01' }), now), false);
});

test('countActiveForVendor counts only that vendor, only active', () => {
  const now = new Date(2026, 8, 12);
  const promos = [
    promo({ id: '1', vendorId: 'v1' }),
    promo({ id: '2', vendorId: 'v1', reusable: true, useCount: 3 }),
    promo({ id: '3', vendorId: 'v1', useCount: 1 }),
    promo({ id: '4', vendorId: 'v1', expiresAt: '2026-01-01' }),
    promo({ id: '5', vendorId: 'v1', archived: true }),
    promo({ id: '6', vendorId: 'v2' }),
  ];
  assert.equal(countActiveForVendor(promos, 'v1', now), 2);
  assert.equal(countActiveForVendor(promos, 'v2', now), 1);
  assert.equal(countActiveForVendor(promos, 'nope', now), 0);
  assert.equal(countActiveForVendor(null, 'v1', now), 0);
});
