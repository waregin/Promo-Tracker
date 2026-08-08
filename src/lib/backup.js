/**
 * Backup payload construction and change detection.
 *
 * Pure and DOM-free so the service worker can use it (no `document`, no
 * `URL.createObjectURL` — neither exists in an MV3 worker) and so Node can test
 * it.
 */

import { CURRENT_VERSION } from './schema.js';

/** At most one automatic backup per this interval, even if data keeps changing. */
export const MIN_BACKUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * The export document — exactly the shape in spec §3. Shared with the manual
 * export so a scheduled backup and a hand-clicked one produce identical files.
 * @param {{vendors: object[], promos: object[]}} doc
 * @param {Date} [now]
 */
export function buildExportDocument(doc, now = new Date()) {
  return {
    version: CURRENT_VERSION,
    exportedAt: now.toISOString(),
    vendors: doc.vendors,
    promos: doc.promos,
  };
}

/**
 * JSON with object keys in a fixed order, so two documents with the same
 * content always produce the same string. `JSON.stringify` follows insertion
 * order, which changes as records are edited — without this, the change
 * detector would fire on every write.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(/** @type {any} */ (value)[key])}`)
    .join(',');
  return `{${body}}`;
}

/**
 * A fingerprint of the data worth backing up.
 *
 * Deliberately covers only `vendors` and `promos`. `exportedAt` changes on
 * every export, and letting it into the hash would make each backup trigger the
 * next one.
 * @param {{vendors: object[], promos: object[]}} doc
 * @returns {Promise<string>} hex SHA-256
 */
export async function contentHash(doc) {
  const canonical = stableStringify({ vendors: doc?.vendors ?? [], promos: doc?.promos ?? [] });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * `data:` URL for a JSON payload.
 *
 * A service worker has no `URL.createObjectURL`, so `chrome.downloads` has to
 * be handed a data URL. `btoa` only accepts latin-1, and promo text is full of
 * “smart quotes”, × and accented names, so the string is UTF-8 encoded first.
 * @param {string} text
 */
export function toJsonDataUrl(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000; // spreading the whole array blows the call stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:application/json;base64,${btoa(binary)}`;
}

/**
 * One file per day. A second backup on the same day replaces that day's file
 * rather than piling up `(1)`, `(2)` copies, while older days are left alone —
 * so a corrupted save can never wipe out yesterday's good copy.
 * @param {Date} [now]
 */
export function backupBasename(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `promo-codes-${stamp}.json`;
}

/**
 * Clean a Downloads-relative subfolder.
 *
 * chrome.downloads refuses absolute paths, `~` and anything containing `..`
 * (verified: it throws "Invalid filename"), so those are stripped here rather
 * than left to fail at write time.
 * @param {string} input
 * @returns {string} a safe relative path, or '' for "straight into Downloads"
 */
export function normalizeSubfolder(input) {
  return String(input ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..' && part !== '~')
    .map((part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, '-'))
    .join('/');
}

/**
 * Should a backup run now?
 *
 * @param {{lastHash?: string|null, lastRunAt?: string|null}} target state for one destination
 * @param {string} hash current content hash
 * @param {{now?: Date, force?: boolean, minIntervalMs?: number}} [options]
 * @returns {{run: boolean, reason: string}}
 */
export function shouldBackUp(target, hash, options = {}) {
  const now = options.now ?? new Date();
  const minInterval = options.minIntervalMs ?? MIN_BACKUP_INTERVAL_MS;

  if (options.force) return { run: true, reason: 'asked for it' };
  if (!target?.lastHash) return { run: true, reason: 'no backup yet' };
  if (target.lastHash !== hash) {
    const last = target.lastRunAt ? new Date(target.lastRunAt).getTime() : 0;
    const elapsed = now.getTime() - last;
    if (Number.isFinite(last) && elapsed < minInterval) {
      return { run: false, reason: 'changed, but backed up recently' };
    }
    return { run: true, reason: 'data changed' };
  }
  return { run: false, reason: 'unchanged since the last backup' };
}

