/**
 * Display formatting. Deliberately hand-rolled rather than Intl-based so the
 * output is identical everywhere and can be asserted in tests.
 */

import { parseExpiry, isExpired } from './status.js';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * "12 Sep 2026". Date-only strings are read component-wise so no timezone
 * shift can move them onto the wrong day.
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function formatDate(value) {
  if (!value) return null;
  const text = String(value).trim();

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const month = MONTHS[Number(m) - 1];
    if (!month) return null;
    return `${Number(d)} ${month} ${Number(y)}`;
  }

  const parsed = parseExpiry(text);
  if (!parsed) return null;
  return `${parsed.getDate()} ${MONTHS[parsed.getMonth()]} ${parsed.getFullYear()}`;
}

/**
 * The expiry line, rendering all four confidence states honestly (spec §4).
 *
 * The distinction that matters: `none` means the offer said it never expires,
 * `unknown` means nobody said anything. Collapsing those two into "No
 * expiration" would invent a promise the vendor never made.
 * @param {{ expiresAt?: string|null, expiryConfidence?: string }} promo
 * @param {Date} [now]
 * @returns {string}
 */
export function formatExpiryLine(promo, now = new Date()) {
  if (promo?.expiryConfidence === 'none') return 'No expiration';

  const formatted = formatDate(promo?.expiresAt);
  if (!formatted) return 'No expiration date given';

  return isExpired(promo, now) ? `Expired ${formatted}` : `Expires ${formatted}`;
}

/**
 * Whole days elapsed since an ISO timestamp; null if never / unparseable.
 * @param {string|null|undefined} iso
 * @param {Date} [now]
 * @returns {number|null}
 */
export function daysSince(iso, now = new Date()) {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}

/**
 * The export-backup nudge shown in the popup's list view (spec §5).
 * Returns null when there is nothing worth nagging about.
 * @param {{ exportedAt?: string|null, promos?: object[] }} doc
 * @param {Date} [now]
 * @returns {string|null}
 */
export function exportNudge(doc, now = new Date()) {
  if (!doc?.promos?.length) return null;
  const days = daysSince(doc.exportedAt, now);
  if (days === null) return 'Never exported — save a backup.';
  if (days > 14) return `Last exported: ${days} days ago.`;
  return null;
}

/**
 * Filename for an export: promo-codes-YYYY-MM-DD.json (spec §5).
 * @param {Date} [now]
 */
export function exportFilename(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `promo-codes-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

/**
 * Human label for a derived status, or null for `active` (which needs no chip).
 * @param {'archived'|'spent'|'expired'|'active'} status
 */
export function statusLabel(status) {
  switch (status) {
    case 'archived': return 'Archived';
    case 'spent': return 'Used';
    case 'expired': return 'Expired';
    default: return null;
  }
}
