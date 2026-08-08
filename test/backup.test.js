import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stableStringify,
  contentHash,
  toJsonDataUrl,
  backupBasename,
  normalizeSubfolder,
  shouldBackUp,
  buildExportDocument,
  MIN_BACKUP_INTERVAL_MS,
} from '../src/lib/backup.js';
import { createSettingsStore, defaultSettings, normalizeSettings } from '../src/lib/settings.js';
import { CURRENT_VERSION } from '../src/lib/schema.js';

/* ---- stable stringify + hashing --------------------------------------- */

test('stableStringify ignores key order', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.equal(stableStringify({ a: { x: 1, y: 2 } }), stableStringify({ a: { y: 2, x: 1 } }));
});

test('stableStringify keeps array order, which is meaningful', () => {
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
});

test('stableStringify handles the awkward values', () => {
  assert.equal(stableStringify(null), 'null');
  assert.equal(stableStringify(undefined), 'null');
  assert.equal(stableStringify('x'), '"x"');
  assert.equal(stableStringify([null, undefined]), '[null,null]');
});

const doc = (promos, vendors = [{ id: 'v1', name: 'V' }]) => ({ vendors, promos });

test('the hash tracks content, not field order', async () => {
  const a = await contentHash(doc([{ id: 'p1', code: 'A', title: 'x' }]));
  const b = await contentHash(doc([{ title: 'x', code: 'A', id: 'p1' }]));
  assert.equal(a, b);
});

test('the hash changes when a code changes', async () => {
  const a = await contentHash(doc([{ id: 'p1', code: 'A' }]));
  const b = await contentHash(doc([{ id: 'p1', code: 'B' }]));
  assert.notEqual(a, b);
});

test('the hash ignores exportedAt, so a backup cannot trigger the next one', async () => {
  const base = doc([{ id: 'p1', code: 'A' }]);
  const a = await contentHash({ ...base, exportedAt: '2026-01-01T00:00:00Z' });
  const b = await contentHash({ ...base, exportedAt: '2026-08-08T00:00:00Z' });
  assert.equal(a, b);
});

test('the hash survives an empty document', async () => {
  assert.equal(typeof await contentHash({}), 'string');
  assert.equal((await contentHash({ vendors: [], promos: [] })).length, 64);
});

/* ---- data URL ---------------------------------------------------------- */

test('data URL round trips ASCII', () => {
  const url = toJsonDataUrl('{"a":1}');
  assert.match(url, /^data:application\/json;base64,/);
  assert.equal(Buffer.from(url.split(',')[1], 'base64').toString('utf8'), '{"a":1}');
});

test('data URL round trips the characters promo text actually contains', () => {
  // btoa() throws on any of these; the encoder has to go through UTF-8 first.
  const text = JSON.stringify({ title: '20% off — “sitewide”', notes: 'Used 3× · café ½ price 🎉' });
  const decoded = Buffer.from(toJsonDataUrl(text).split(',')[1], 'base64').toString('utf8');
  assert.equal(decoded, text);
});

test('data URL handles a payload larger than one chunk', () => {
  const text = JSON.stringify({ blob: 'é'.repeat(50_000) });
  const decoded = Buffer.from(toJsonDataUrl(text).split(',')[1], 'base64').toString('utf8');
  assert.equal(decoded, text);
});

/* ---- filenames --------------------------------------------------------- */

test('one file per day', () => {
  assert.equal(backupBasename(new Date(2026, 7, 8)), 'promo-codes-2026-08-08.json');
  assert.equal(backupBasename(new Date(2026, 11, 31)), 'promo-codes-2026-12-31.json');
});

test('subfolder normalization strips what chrome.downloads rejects', () => {
  // Verified against the real API: absolute paths, ~ and .. all throw
  // "Invalid filename".
  assert.equal(normalizeSubfolder('promo-tracker'), 'promo-tracker');
  assert.equal(normalizeSubfolder('/promo-tracker/'), 'promo-tracker');
  assert.equal(normalizeSubfolder('../../etc'), 'etc');
  assert.equal(normalizeSubfolder('~/backups'), 'backups');
  assert.equal(normalizeSubfolder('a/../b'), 'a/b');
  assert.equal(normalizeSubfolder('back\\slash'), 'back/slash');
  assert.equal(normalizeSubfolder('  spaced  '), 'spaced');
  assert.equal(normalizeSubfolder('bad:name?'), 'bad-name-');
  assert.equal(normalizeSubfolder(''), '');
  assert.equal(normalizeSubfolder('///'), '');
  assert.equal(normalizeSubfolder(null), '');
});

/* ---- scheduling -------------------------------------------------------- */

const now = new Date('2026-08-08T12:00:00Z');
const ago = (ms) => new Date(now.getTime() - ms).toISOString();

test('the first ever run always goes ahead', () => {
  assert.equal(shouldBackUp({ lastHash: null }, 'abc', { now }).run, true);
});

test('unchanged data is not backed up again', () => {
  const result = shouldBackUp({ lastHash: 'abc', lastRunAt: ago(0) }, 'abc', { now });
  assert.equal(result.run, false);
  assert.match(result.reason, /unchanged/);
});

test('changed data is backed up once the interval has passed', () => {
  const stale = { lastHash: 'abc', lastRunAt: ago(MIN_BACKUP_INTERVAL_MS + 1000) };
  assert.equal(shouldBackUp(stale, 'xyz', { now }).run, true);
});

test('a burst of edits does not produce a burst of backups', () => {
  const fresh = { lastHash: 'abc', lastRunAt: ago(60_000) };
  const result = shouldBackUp(fresh, 'xyz', { now });
  assert.equal(result.run, false);
  assert.match(result.reason, /recently/);
});

test('"Back up now" overrides both the interval and the hash', () => {
  const fresh = { lastHash: 'abc', lastRunAt: ago(1000) };
  assert.equal(shouldBackUp(fresh, 'abc', { now, force: true }).run, true);
});

/* ---- export payload ---------------------------------------------------- */

test('a scheduled backup writes the same shape as a manual export', () => {
  const built = buildExportDocument({ vendors: [{ id: 'v' }], promos: [{ id: 'p' }] }, now);
  assert.deepEqual(Object.keys(built).sort(), ['exportedAt', 'promos', 'vendors', 'version']);
  assert.equal(built.version, CURRENT_VERSION);
  assert.equal(built.exportedAt, now.toISOString());
});

/* ---- settings ---------------------------------------------------------- */

function fakeArea(initial = {}) {
  let data = structuredClone(initial);
  return {
    async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(items) { data = { ...data, ...structuredClone(items) }; },
  };
}

test('backups are off until asked for', () => {
  const settings = defaultSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.destination, 'folder');
  assert.equal(settings.lastRunAt, null);
});

test('settings normalization refuses junk', () => {
  assert.equal(normalizeSettings(null).enabled, false);
  assert.equal(normalizeSettings({ enabled: 'yes' }).enabled, false);
  assert.equal(normalizeSettings({ destination: 'ftp' }).destination, 'folder');
  assert.equal(normalizeSettings({ destination: 'downloads' }).destination, 'downloads');
  assert.equal(normalizeSettings({ subfolder: 42 }).subfolder, 'promo-tracker');
});

test('settings patches merge and persist', async () => {
  const store = createSettingsStore(fakeArea());
  await store.patch({ enabled: true, destination: 'downloads' });
  await store.patch({ lastRunAt: '2026-08-08T00:00:00.000Z' });

  const settings = await store.read();
  assert.equal(settings.enabled, true);
  assert.equal(settings.destination, 'downloads');
  assert.equal(settings.lastRunAt, '2026-08-08T00:00:00.000Z');
  assert.equal(settings.subfolder, 'promo-tracker');
});

test('concurrent patches do not clobber each other', async () => {
  const store = createSettingsStore(fakeArea());
  await Promise.all([
    store.patch({ enabled: true }),
    store.patch({ destination: 'downloads' }),
    store.patch({ folderName: 'Backups' }),
  ]);
  const settings = await store.read();
  assert.equal(settings.enabled, true);
  assert.equal(settings.destination, 'downloads');
  assert.equal(settings.folderName, 'Backups');
});
