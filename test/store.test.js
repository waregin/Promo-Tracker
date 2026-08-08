import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore, STORAGE_KEY } from '../src/lib/store.js';
import { CURRENT_VERSION } from '../src/lib/schema.js';

/** An in-memory stand-in for chrome.storage.local. */
function fakeArea(initial = {}) {
  let data = structuredClone(initial);
  return {
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items) {
      data = { ...data, ...structuredClone(items) };
    },
    peek() {
      return data;
    },
  };
}

test('an empty area reads as an empty document', async () => {
  const store = createStore(fakeArea());
  const doc = await store.read();
  assert.equal(doc.version, CURRENT_VERSION);
  assert.deepEqual(doc.vendors, []);
  assert.deepEqual(doc.promos, []);
  assert.equal(doc.exportedAt, null);
});

test('garbage in storage reads as empty rather than throwing', async () => {
  const store = createStore(fakeArea({ [STORAGE_KEY]: { version: 'banana' } }));
  const doc = await store.read();
  assert.deepEqual(doc.promos, []);
});

test('vendors and promos round trip', async () => {
  const store = createStore(fakeArea());
  const vendor = await store.addVendor({ name: 'Chewy', domains: [{ pattern: 'chewy.com' }] });
  await store.addPromo({ vendorId: vendor.id, code: 'SAVE20', title: '20% off' });

  const doc = await store.read();
  assert.equal(doc.vendors.length, 1);
  assert.equal(doc.promos.length, 1);
  assert.equal(doc.promos[0].code, 'SAVE20');
  assert.equal(doc.promos[0].expiryConfidence, 'unknown');
});

test('markUsed increments and stamps, for reusable codes too', async () => {
  const store = createStore(fakeArea());
  const vendor = await store.addVendor({ name: 'V', domains: [{ pattern: 'v.com' }] });
  const once = await store.addPromo({ vendorId: vendor.id, code: 'ONCE' });
  const many = await store.addPromo({ vendorId: vendor.id, code: 'MANY', reusable: true });

  await store.markUsed(once.id, new Date('2026-08-07T10:00:00Z'));
  await store.markUsed(many.id, new Date('2026-08-07T10:00:00Z'));
  await store.markUsed(many.id, new Date('2026-08-08T10:00:00Z'));

  const doc = await store.read();
  const a = doc.promos.find((p) => p.id === once.id);
  const b = doc.promos.find((p) => p.id === many.id);

  assert.equal(a.useCount, 1);
  assert.equal(a.lastUsedAt, '2026-08-07T10:00:00.000Z');
  assert.equal(b.useCount, 2);
  assert.equal(b.lastUsedAt, '2026-08-08T10:00:00.000Z');
});

test('unmarkUsed never goes below zero', async () => {
  const store = createStore(fakeArea());
  const vendor = await store.addVendor({ name: 'V', domains: [{ pattern: 'v.com' }] });
  const promo = await store.addPromo({ vendorId: vendor.id, code: 'X' });

  await store.unmarkUsed(promo.id);
  assert.equal((await store.read()).promos[0].useCount, 0);
});

test('updatePromo keeps createdAt and moves updatedAt', async () => {
  const store = createStore(fakeArea());
  const vendor = await store.addVendor({ name: 'V', domains: [{ pattern: 'v.com' }] });
  const promo = await store.addPromo({ vendorId: vendor.id, code: 'X', createdAt: '2026-01-01T00:00:00.000Z' });

  await store.updatePromo(promo.id, { title: 'Renamed' });
  const saved = (await store.read()).promos[0];

  assert.equal(saved.title, 'Renamed');
  assert.equal(saved.createdAt, '2026-01-01T00:00:00.000Z');
  assert.notEqual(saved.updatedAt, '2026-01-01T00:00:00.000Z');
});

test('removing a vendor removes its promos, not everyone else’s', async () => {
  const store = createStore(fakeArea());
  const a = await store.addVendor({ name: 'A', domains: [{ pattern: 'a.com' }] });
  const b = await store.addVendor({ name: 'B', domains: [{ pattern: 'b.com' }] });
  await store.addPromo({ vendorId: a.id, code: 'A1' });
  await store.addPromo({ vendorId: b.id, code: 'B1' });

  await store.removeVendor(a.id);
  const doc = await store.read();

  assert.equal(doc.vendors.length, 1);
  assert.equal(doc.promos.length, 1);
  assert.equal(doc.promos[0].code, 'B1');
});

test('concurrent writes are serialized, not lost', async () => {
  const store = createStore(fakeArea());
  const vendor = await store.addVendor({ name: 'V', domains: [{ pattern: 'v.com' }] });

  // The popup and the full page can both be open. Fire ten writes without
  // awaiting between them and none may be dropped.
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => store.addPromo({ vendorId: vendor.id, code: `C${i}` })),
  );

  const doc = await store.read();
  assert.equal(doc.promos.length, 10);
});

test('a v1 document in storage is migrated on read', async () => {
  // What the owner's browser actually holds after upgrading the extension.
  const store = createStore(fakeArea({
    [STORAGE_KEY]: {
      version: 1,
      exportedAt: null,
      vendors: [{ id: 'v1', name: 'Chewy', domains: [{ pattern: 'chewy.com' }] }],
      promos: [{ id: 'p1', vendorId: 'v1', code: 'SAVE20', terms: 'One per customer.' }],
    },
  }));

  const doc = await store.read();
  assert.equal(doc.version, CURRENT_VERSION);
  assert.equal(doc.promos[0].notes, 'One per customer.');
  assert.equal(doc.promos[0].code, 'SAVE20');
});

test('a vendor with no domains round trips', async () => {
  const store = createStore(fakeArea());
  const vendor = await store.addVendor({ name: 'Local plumber', domains: [] });
  await store.addPromo({ vendorId: vendor.id, code: 'NEIGHBOUR10', title: '10% off labour' });

  const doc = await store.read();
  assert.equal(doc.vendors[0].domains.length, 0);
  assert.equal(doc.promos.length, 1);
});

test('recordExport stamps the document', async () => {
  const store = createStore(fakeArea());
  await store.recordExport(new Date('2026-08-07T00:00:00Z'));
  assert.equal((await store.read()).exportedAt, '2026-08-07T00:00:00.000Z');
});
