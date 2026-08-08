/**
 * The single storage accessor (spec §5, §9).
 *
 * Everything in the extension reads and writes through the `store` exported
 * here. Switching where the data lives is the one-line change below.
 *
 *   'local' — stays on this machine. Cleared if the extension is removed, so
 *             the JSON export is the only backup. This is the default and the
 *             owner's confirmed choice.
 *   'sync'  — roams across Chrome profiles and is backed up through the Google
 *             account, but is unencrypted in Google's cloud. 7 codes fit inside
 *             the 100KB / 8KB-per-item / 512-item limits with room to spare.
 *
 * Changing this constant does not migrate existing data — export first, switch,
 * then import.
 */

import { createStore, STORAGE_KEY } from './store.js';

/** @type {'local'|'sync'} */
export const STORAGE_AREA_NAME = 'local';

export function storageArea() {
  return chrome.storage[STORAGE_AREA_NAME];
}

export const store = createStore(storageArea());

export { STORAGE_KEY };
