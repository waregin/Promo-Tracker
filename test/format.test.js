import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatDate,
  formatExpiryLine,
  daysSince,
  exportNudge,
  exportFilename,
  statusLabel,
} from '../src/lib/format.js';

test('formatDate renders the spec format without timezone drift', () => {
  assert.equal(formatDate('2026-09-12'), '12 Sep 2026');
  assert.equal(formatDate('2026-01-01'), '1 Jan 2026');
  assert.equal(formatDate('2026-12-31'), '31 Dec 2026');
  assert.equal(formatDate(null), null);
  assert.equal(formatDate('gibberish'), null);
});

test('the four expiry confidence states render differently', () => {
  const now = new Date(2026, 7, 1);

  assert.equal(
    formatExpiryLine({ expiresAt: '2026-09-12', expiryConfidence: 'explicit' }, now),
    'Expires 12 Sep 2026',
  );
  assert.equal(
    formatExpiryLine({ expiresAt: '2026-09-12', expiryConfidence: 'inferred' }, now),
    'Expires 12 Sep 2026',
  );
  assert.equal(
    formatExpiryLine({ expiresAt: null, expiryConfidence: 'none' }, now),
    'No expiration',
  );
  assert.equal(
    formatExpiryLine({ expiresAt: null, expiryConfidence: 'unknown' }, now),
    'No expiration date given',
  );
});

test('unknown is never rendered as a promise of permanence', () => {
  // The non-negotiable in spec §10: these two must not collapse into one string.
  const none = formatExpiryLine({ expiresAt: null, expiryConfidence: 'none' });
  const unknown = formatExpiryLine({ expiresAt: null, expiryConfidence: 'unknown' });
  assert.notEqual(none, unknown);
  assert.equal(unknown.includes('date'), true);
});

test('a past date reads as expired', () => {
  const now = new Date(2026, 9, 1);
  assert.equal(
    formatExpiryLine({ expiresAt: '2026-09-12', expiryConfidence: 'explicit' }, now),
    'Expired 12 Sep 2026',
  );
});

test('"none" wins even if a stray date is present', () => {
  assert.equal(
    formatExpiryLine({ expiresAt: '2026-09-12', expiryConfidence: 'none' }, new Date(2026, 7, 1)),
    'No expiration',
  );
});

test('a date with unknown confidence still shows the date', () => {
  assert.equal(
    formatExpiryLine({ expiresAt: '2026-09-12', expiryConfidence: 'unknown' }, new Date(2026, 7, 1)),
    'Expires 12 Sep 2026',
  );
});

test('daysSince counts whole days', () => {
  const now = new Date('2026-08-20T12:00:00Z');
  assert.equal(daysSince('2026-08-20T00:00:00Z', now), 0);
  assert.equal(daysSince('2026-08-19T00:00:00Z', now), 1);
  assert.equal(daysSince('2026-08-01T12:00:00Z', now), 19);
  assert.equal(daysSince(null, now), null);
  assert.equal(daysSince('nonsense', now), null);
});

test('the export nudge appears only past 14 days, and only with data', () => {
  const now = new Date('2026-08-20T12:00:00Z');
  const promos = [{ id: 'p' }];

  assert.equal(exportNudge({ promos: [], exportedAt: null }, now), null);
  assert.equal(exportNudge({ promos, exportedAt: '2026-08-19T12:00:00Z' }, now), null);
  assert.equal(exportNudge({ promos, exportedAt: '2026-08-06T12:00:00Z' }, now), null); // exactly 14
  assert.equal(exportNudge({ promos, exportedAt: '2026-08-05T12:00:00Z' }, now), 'Last exported: 15 days ago.');
  assert.match(exportNudge({ promos, exportedAt: null }, now), /Never exported/);
});

test('export filename matches the spec', () => {
  assert.equal(exportFilename(new Date(2026, 7, 4)), 'promo-codes-2026-08-04.json');
  assert.equal(exportFilename(new Date(2026, 11, 31)), 'promo-codes-2026-12-31.json');
});

test('active status has no chip', () => {
  assert.equal(statusLabel('active'), null);
  assert.equal(statusLabel('spent'), 'Used');
  assert.equal(statusLabel('expired'), 'Expired');
  assert.equal(statusLabel('archived'), 'Archived');
});
