import test from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyDocument,
  makeVendor,
  makePromo,
  makeDomain,
  normalizeDocument,
  mergeDocuments,
  normalizeDateOnly,
  CURRENT_VERSION,
} from '../src/lib/schema.js';

test('a new promo defaults to unknown expiry, never none', () => {
  // Spec §10: a missing date is not a promise of permanence.
  const promo = makePromo({ vendorId: 'v' });
  assert.equal(promo.expiryConfidence, 'unknown');
  assert.equal(promo.expiresAt, null);
  assert.equal(promo.reusable, false);
  assert.equal(promo.stackable, 'unknown');
  assert.equal(promo.useCount, 0);
  assert.equal(promo.archived, false);
  assert.equal(promo.lastUsedAt, null);
  assert.ok(promo.id);
  assert.equal(promo.createdAt, promo.updatedAt);
});

test('unrecognised enum values fall back to the documented default', () => {
  assert.equal(makePromo({ expiryConfidence: 'someday' }).expiryConfidence, 'unknown');
  assert.equal(makePromo({ stackable: 'maybe' }).stackable, 'unknown');
  assert.equal(makeDomain({ pattern: 'a.com', matchType: 'regex' }).matchType, 'suffix');
});

test('all four expiry confidence values survive a round trip', () => {
  for (const value of ['explicit', 'inferred', 'none', 'unknown']) {
    assert.equal(makePromo({ expiryConfidence: value }).expiryConfidence, value);
  }
});

test('blank strings become null rather than empty text', () => {
  const promo = makePromo({ code: '   ', notes: '', sourceNote: null });
  assert.equal(promo.code, null);
  assert.equal(promo.notes, null);
  assert.equal(promo.sourceNote, null);
});

test('useCount is coerced to a non-negative integer', () => {
  assert.equal(makePromo({ useCount: -3 }).useCount, 0);
  assert.equal(makePromo({ useCount: 2.7 }).useCount, 2);
  assert.equal(makePromo({ useCount: 'lots' }).useCount, 0);
});

test('normalizeDateOnly keeps date-only and trims timestamps down', () => {
  assert.equal(normalizeDateOnly('2026-09-12'), '2026-09-12');
  assert.equal(normalizeDateOnly(null), null);
  assert.equal(normalizeDateOnly('nope'), null);
});

test('vendor domains are normalized and de-duplicated', () => {
  const vendor = makeVendor({
    name: 'Chewy',
    domains: [
      { pattern: 'https://www.chewy.com/deals' },
      { pattern: 'www.chewy.com' },
      { pattern: '' },
      { pattern: 'chewy.com', matchType: 'exact' },
    ],
  });
  assert.deepEqual(vendor.domains, [
    { pattern: 'www.chewy.com', matchType: 'suffix' },
    { pattern: 'chewy.com', matchType: 'exact' },
  ]);
});

test('normalizeDocument refuses a document from a newer version', () => {
  const result = normalizeDocument({ version: 99, vendors: [], promos: [] });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /version 99/);
});

test('normalizeDocument rejects non-documents', () => {
  for (const bad of [null, undefined, 42, 'text', [], {}]) {
    assert.equal(normalizeDocument(bad).ok, false);
  }
});

test('normalizeDocument fills defaults and reports orphans', () => {
  const result = normalizeDocument({
    version: 1,
    vendors: [{ id: 'v1', name: 'Chewy', domains: [{ pattern: 'chewy.com' }] }],
    promos: [
      { id: 'p1', vendorId: 'v1', code: 'A' },
      { id: 'p2', vendorId: 'ghost', code: 'B' },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.doc.promos.length, 1);
  assert.equal(result.doc.promos[0].expiryConfidence, 'unknown');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /missing vendor/);
});

test('a vendor with no domains is a supported state, not a warning', () => {
  // The plumber has no website. The record is still worth keeping; it simply
  // never badges a tab.
  const result = normalizeDocument({
    version: 2,
    vendors: [{ id: 'v1', name: 'Local plumber', domains: [] }],
    promos: [{ id: 'p1', vendorId: 'v1', code: 'NEIGHBOUR10' }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.doc.vendors[0].domains.length, 0);
  assert.equal(result.doc.promos.length, 1);
});

test('v1 documents migrate: promo `terms` becomes `notes`', () => {
  const result = normalizeDocument({
    version: 1,
    vendors: [{ id: 'v1', name: 'Chewy', domains: [{ pattern: 'chewy.com' }] }],
    promos: [{ id: 'p1', vendorId: 'v1', code: 'A', terms: 'One per customer.' }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.doc.version, CURRENT_VERSION);
  assert.equal(result.doc.promos[0].notes, 'One per customer.');
  assert.equal('terms' in result.doc.promos[0], false);
});

test('migration never drops text a v1 record was carrying', () => {
  const result = normalizeDocument({
    version: 1,
    vendors: [{ id: 'v1', name: 'V', domains: [{ pattern: 'v.com' }] }],
    promos: [
      { id: 'p1', vendorId: 'v1', code: 'A', terms: 'kept' },
      { id: 'p2', vendorId: 'v1', code: 'B', terms: null },
      { id: 'p3', vendorId: 'v1', code: 'C' },
    ],
  });
  assert.deepEqual(result.doc.promos.map((p) => p.notes), ['kept', null, null]);
});

test('a v2 document passes through untouched', () => {
  const result = normalizeDocument({
    version: 2,
    vendors: [{ id: 'v1', name: 'V', domains: [{ pattern: 'v.com' }] }],
    promos: [{ id: 'p1', vendorId: 'v1', code: 'A', notes: 'already migrated' }],
  });
  assert.equal(result.doc.promos[0].notes, 'already migrated');
});

test('merge keeps the newer record on an id collision', () => {
  const vendor = { id: 'v1', name: 'Chewy', domains: [{ pattern: 'chewy.com', matchType: 'suffix' }], notes: null };
  const current = {
    ...emptyDocument(),
    vendors: [vendor],
    promos: [makePromo({ id: 'p1', vendorId: 'v1', code: 'NEW', updatedAt: '2026-08-10T00:00:00Z' })],
  };
  const incoming = {
    ...emptyDocument(),
    vendors: [vendor],
    promos: [
      makePromo({ id: 'p1', vendorId: 'v1', code: 'OLD', updatedAt: '2026-01-01T00:00:00Z' }),
      makePromo({ id: 'p2', vendorId: 'v1', code: 'EXTRA', updatedAt: '2026-01-01T00:00:00Z' }),
    ],
  };

  const merged = mergeDocuments(current, incoming);
  assert.equal(merged.promos.length, 2);
  // Importing an older backup must not roll back a newer edit.
  assert.equal(merged.promos.find((p) => p.id === 'p1').code, 'NEW');
  assert.equal(merged.promos.find((p) => p.id === 'p2').code, 'EXTRA');
  assert.equal(merged.version, CURRENT_VERSION);
});

test('merge brings in the vendor an imported promo needs', () => {
  const current = emptyDocument();
  const incoming = {
    ...emptyDocument(),
    vendors: [{ id: 'v9', name: 'New', domains: [{ pattern: 'new.com', matchType: 'suffix' }], notes: null }],
    promos: [makePromo({ id: 'p9', vendorId: 'v9', code: 'X' })],
  };
  const merged = mergeDocuments(current, incoming);
  assert.equal(merged.vendors.length, 1);
  assert.equal(merged.promos.length, 1);
});

test('merge prefers the vendor record carrying more domains', () => {
  const current = {
    ...emptyDocument(),
    vendors: [{ id: 'v1', name: 'Chewy', domains: [{ pattern: 'chewy.com', matchType: 'suffix' }], notes: null }],
  };
  const incoming = {
    ...emptyDocument(),
    vendors: [{
      id: 'v1',
      name: 'Chewy',
      domains: [
        { pattern: 'chewy.com', matchType: 'suffix' },
        { pattern: 'chewy.ca', matchType: 'suffix' },
      ],
      notes: null,
    }],
  };
  assert.equal(mergeDocuments(current, incoming).vendors[0].domains.length, 2);
});
