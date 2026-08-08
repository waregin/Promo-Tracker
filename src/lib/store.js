/**
 * Document store over a storage area.
 *
 * The area is injected rather than reached for, which is what makes this
 * testable in Node and what makes the local/sync switch in storage.js a
 * one-line change (spec §5, §9).
 */

import { emptyDocument, normalizeDocument, makePromo, makeVendor, CURRENT_VERSION } from './schema.js';

export const STORAGE_KEY = 'promoData';

/**
 * @typedef {{ get(keys?: any): Promise<Record<string, any>>, set(items: Record<string, any>): Promise<void> }} StorageArea
 */

/**
 * @param {StorageArea} area
 * @param {string} [key]
 */
export function createStore(area, key = STORAGE_KEY) {
  // Writes are serialized. Two surfaces are open at once (popup and the full
  // page), and a read-modify-write from each can otherwise clobber the other.
  /** @type {Promise<any>} */
  let queue = Promise.resolve();

  async function read() {
    const got = await area.get(key);
    const raw = got?.[key];
    if (!raw) return emptyDocument();
    const { ok, doc } = normalizeDocument(raw);
    return ok ? doc : emptyDocument();
  }

  /** @param {ReturnType<typeof emptyDocument>} doc */
  async function write(doc) {
    await area.set({ [key]: doc });
    return doc;
  }

  /**
   * Read, apply, write — as one queued step.
   * @param {(doc: ReturnType<typeof emptyDocument>) => any} mutator
   */
  function update(mutator) {
    const next = queue.then(async () => {
      const doc = await read();
      const result = (await mutator(doc)) ?? doc;
      return write(result);
    });
    // Keep the chain alive even if one step rejects.
    queue = next.catch(() => {});
    return next;
  }

  return {
    key,
    read,
    write,
    update,

    /** @param {object} input */
    addVendor(input) {
      const vendor = makeVendor(input);
      return update((doc) => ({ ...doc, vendors: [...doc.vendors, vendor] })).then(() => vendor);
    },

    /** @param {string} id @param {object} patch */
    updateVendor(id, patch) {
      return update((doc) => ({
        ...doc,
        vendors: doc.vendors.map((v) => (v.id === id ? makeVendor({ ...v, ...patch, id }) : v)),
      }));
    },

    /**
     * Removing a vendor removes its promos too — an orphan promo is invisible
     * in every view, so leaving one behind would look like silent data loss.
     * @param {string} id
     */
    removeVendor(id) {
      return update((doc) => ({
        ...doc,
        vendors: doc.vendors.filter((v) => v.id !== id),
        promos: doc.promos.filter((p) => p.vendorId !== id),
      }));
    },

    /** @param {object} input */
    addPromo(input) {
      const promo = makePromo(input);
      return update((doc) => ({ ...doc, promos: [...doc.promos, promo] })).then(() => promo);
    },

    /** @param {string} id @param {object} patch */
    updatePromo(id, patch) {
      return update((doc) => ({
        ...doc,
        promos: doc.promos.map((p) =>
          p.id === id
            ? makePromo({ ...p, ...patch, id, createdAt: p.createdAt, updatedAt: new Date().toISOString() })
            : p,
        ),
      }));
    },

    /** @param {string} id */
    removePromo(id) {
      return update((doc) => ({ ...doc, promos: doc.promos.filter((p) => p.id !== id) }));
    },

    /**
     * Mark a code used. Increments for reusable codes too — there the count is
     * informational rather than a spent flag (spec §3).
     * @param {string} id
     * @param {Date} [now]
     */
    markUsed(id, now = new Date()) {
      return update((doc) => ({
        ...doc,
        promos: doc.promos.map((p) =>
          p.id === id
            ? { ...p, useCount: (p.useCount ?? 0) + 1, lastUsedAt: now.toISOString(), updatedAt: now.toISOString() }
            : p,
        ),
      }));
    },

    /** @param {string} id @param {Date} [now] */
    unmarkUsed(id, now = new Date()) {
      return update((doc) => ({
        ...doc,
        promos: doc.promos.map((p) =>
          p.id === id
            ? { ...p, useCount: Math.max(0, (p.useCount ?? 0) - 1), updatedAt: now.toISOString() }
            : p,
        ),
      }));
    },

    /** Stamp the export time so the backup nudge can go quiet. @param {Date} [now] */
    recordExport(now = new Date()) {
      return update((doc) => ({ ...doc, exportedAt: now.toISOString() }));
    },

    /** @param {ReturnType<typeof emptyDocument>} doc */
    replaceAll(doc) {
      return update(() => ({ ...doc, version: CURRENT_VERSION }));
    },
  };
}
