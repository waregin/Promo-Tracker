/**
 * The extension API, and the handful of capability checks that differ between
 * engines.
 *
 * Firefox (and so LibreWolf) exposes the promise-returning API as `browser`.
 * Chrome exposes it as `chrome`. Firefox *also* defines `chrome`, but as the
 * older callback-style alias, so `browser` has to be preferred where it exists
 * — every call in this codebase is awaited.
 */

import { toJsonDataUrl } from './backup.js';

/** @type {typeof chrome} */
export const api = /** @type {any} */ (globalThis).browser ?? /** @type {any} */ (globalThis).chrome;

/**
 * Which engine are we on? Used only to phrase messages and to pick defaults —
 * never to gate behaviour that can be feature-detected instead.
 */
export const isFirefox = Boolean(/** @type {any} */ (globalThis).browser?.runtime?.getBrowserInfo);

/**
 * Can the owner be shown a folder picker here?
 *
 * Two separate questions, and conflating them is a trap: `showDirectoryPicker`
 * exists only in a *page*, never in a service worker, so the background must
 * not use this to decide whether it can write. Use it for UI decisions only.
 *
 * The File System Access API is Chromium-only. Firefox has no equivalent — its
 * origin-private file system lives inside the profile, which is exactly where a
 * backup must not be. So on LibreWolf this is false and the folder destination
 * is hidden rather than offered and silently broken.
 */
export function supportsDirectoryPicker() {
  return typeof (/** @type {any} */ (globalThis).showDirectoryPicker) === 'function';
}

/**
 * Can this context write through a directory handle someone already picked?
 *
 * True in a Chromium service worker, where the picker is absent but the handle
 * machinery is present. False on Firefox, which has neither.
 */
export function supportsFolderWrites() {
  return typeof (/** @type {any} */ (globalThis).FileSystemDirectoryHandle) === 'function';
}

/**
 * A URL the downloads API can fetch, for a string we hold in memory.
 *
 * Firefox's background script runs in a page context, so `URL.createObjectURL`
 * exists and a blob URL is the well-supported route. A Chrome MV3 service
 * worker has no `URL.createObjectURL` at all, so it falls back to a data URL —
 * verified working against `chrome.downloads.download`.
 *
 * @param {string} text
 * @returns {{url: string, revoke: () => void}}
 */
export function downloadableUrl(text) {
  if (typeof URL.createObjectURL === 'function' && typeof Blob === 'function') {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }

  return { url: toJsonDataUrl(text), revoke: () => {} };
}
