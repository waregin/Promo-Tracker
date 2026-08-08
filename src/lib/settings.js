/**
 * Automatic-backup settings.
 *
 * Kept under their own storage key, deliberately outside the exported document:
 * a backup destination is a property of this machine, and carrying it into an
 * export would mean importing someone else's folder choice.
 */

export const SETTINGS_KEY = 'promoBackupSettings';

/** @typedef {'folder'|'downloads'} BackupDestination */

export function defaultSettings() {
  return {
    enabled: false,
    /** @type {BackupDestination} */
    destination: 'folder',
    /** Downloads-relative path, used only when destination is 'downloads'. */
    subfolder: 'promo-tracker',
    /** Display name of the chosen folder, for the UI. The handle is in IndexedDB. */
    folderName: /** @type {string|null} */ (null),
    lastRunAt: /** @type {string|null} */ (null),
    lastHash: /** @type {string|null} */ (null),
    lastPath: /** @type {string|null} */ (null),
    lastError: /** @type {string|null} */ (null),
    /** Set when the folder grant lapsed and only a click can restore it. */
    needsPermission: false,
  };
}

/** @param {any} raw */
export function normalizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    enabled: raw.enabled === true,
    destination: raw.destination === 'downloads' ? 'downloads' : 'folder',
    subfolder: typeof raw.subfolder === 'string' ? raw.subfolder : base.subfolder,
    needsPermission: raw.needsPermission === true,
  };
}

/**
 * @param {{get(k: string): Promise<Record<string, any>>, set(items: Record<string, any>): Promise<void>}} area
 * @param {string} [key]
 */
export function createSettingsStore(area, key = SETTINGS_KEY) {
  /** @type {Promise<any>} */
  let queue = Promise.resolve();

  async function read() {
    const got = await area.get(key);
    return normalizeSettings(got?.[key]);
  }

  /** @param {object} patchValue */
  function patch(patchValue) {
    const next = queue.then(async () => {
      const current = await read();
      const merged = normalizeSettings({ ...current, ...patchValue });
      await area.set({ [key]: merged });
      return merged;
    });
    queue = next.catch(() => {});
    return next;
  }

  return { key, read, patch };
}
