/**
 * Persistence for the backup folder handle.
 *
 * A `FileSystemDirectoryHandle` is structured-cloneable but not JSON, so it
 * cannot live in chrome.storage — IndexedDB is the only place it can go. Both
 * the page (which picks the folder) and the service worker (which writes to it)
 * can reach IndexedDB, which is what lets backups run in the background.
 */

const DB_NAME = 'promo-tracker';
const DB_VERSION = 1;
const STORE = 'handles';
const KEY = 'backupDirectory';

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * @template T
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest} run
 * @returns {Promise<T>}
 */
async function withStore(mode, run) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** @param {any} handle */
export function saveDirectoryHandle(handle) {
  return withStore('readwrite', (store) => store.put(handle, KEY));
}

/** @returns {Promise<any|null>} */
export async function loadDirectoryHandle() {
  try {
    return (await withStore('readonly', (store) => store.get(KEY))) ?? null;
  } catch {
    return null;
  }
}

export function clearDirectoryHandle() {
  return withStore('readwrite', (store) => store.delete(KEY));
}

/**
 * Is the stored handle still usable without prompting?
 *
 * Chrome can drop a file-system grant between sessions. The service worker has
 * no user gesture and so can never re-request it, which is why this is reported
 * rather than repaired here — the page shows a "Reconnect" button instead.
 * @param {any} handle
 * @returns {Promise<'granted'|'prompt'|'denied'>}
 */
export async function directoryPermission(handle) {
  if (!handle?.queryPermission) return 'denied';
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}
