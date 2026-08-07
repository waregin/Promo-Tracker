/**
 * Derived promo status (spec §3). Never stored — always computed at read time,
 * because `expired` depends on the clock and `spent` depends on two other
 * fields that the UI can change independently.
 */

/**
 * Parse an expiry value into the instant the offer stops working.
 *
 * A date-only string means "good through the end of that day", so a code
 * expiring today is still usable today. It is also parsed in LOCAL time:
 * `new Date('2026-09-12')` is UTC midnight, which reads as expired a few hours
 * early for anyone west of Greenwich.
 * @param {string|null|undefined} value
 * @returns {Date|null}
 */
export function parseExpiry(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(Number(y), Number(m) - 1, Number(d), 23, 59, 59, 999);
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * @param {{ expiresAt?: string|null }} promo
 * @param {Date} [now]
 */
export function isExpired(promo, now = new Date()) {
  const at = parseExpiry(promo?.expiresAt);
  return at !== null && now.getTime() > at.getTime();
}

/**
 * A single-use code that has been used. Reusable codes are never spent —
 * their `useCount` is informational only (spec §3).
 * @param {{ reusable?: boolean, useCount?: number }} promo
 */
export function isSpent(promo) {
  return !promo?.reusable && (promo?.useCount ?? 0) > 0;
}

/**
 * @param {object} promo
 * @param {Date} [now]
 * @returns {'archived'|'spent'|'expired'|'active'}
 */
export function derivePromoStatus(promo, now = new Date()) {
  if (promo?.archived) return 'archived';
  // `spent` outranks `expired`: if you used a single-use code, that is why it
  // is gone, and it stays the more useful thing to show even after the date
  // passes.
  if (isSpent(promo)) return 'spent';
  if (isExpired(promo, now)) return 'expired';
  return 'active';
}

/**
 * @param {object} promo
 * @param {Date} [now]
 */
export function isActive(promo, now = new Date()) {
  return derivePromoStatus(promo, now) === 'active';
}

/**
 * Count the active promos belonging to one vendor — the number the badge shows.
 * @param {object[]} promos
 * @param {string} vendorId
 * @param {Date} [now]
 */
export function countActiveForVendor(promos, vendorId, now = new Date()) {
  if (!Array.isArray(promos)) return 0;
  let count = 0;
  for (const promo of promos) {
    if (promo?.vendorId === vendorId && isActive(promo, now)) count += 1;
  }
  return count;
}
