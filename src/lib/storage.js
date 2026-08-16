/**
 * The single storage accessor (spec §5, §9).
 *
 * Everything in the extension reads and writes through the `store` exported
 * here. Switching where the data lives is the one-line change below.
 *
 *   'local' — stays on this machine. Cleared if the extension is removed, so
 *             the JSON export is the only backup. This is the default and the
 *             owner's confirmed choice.
 *   'sync'  — roams between profiles signed into the same browser account
 *             (Google on Chrome, Mozilla on Firefox), unencrypted on their
 *             servers. 7 codes fit inside the quotas with room to spare.
 *
 * Changing this constant does not migrate existing data — export first, switch,
 * then import.
 */

import { api } from './api.js';
import { createStore, STORAGE_KEY } from './store.js';

/** @type {'local'|'sync'} */
export const STORAGE_AREA_NAME = 'local';

export function storageArea() {
  return api.storage[STORAGE_AREA_NAME];
}

export const store = createStore(storageArea());

export { STORAGE_KEY };
