/**
 * The automatic backup runner.
 *
 * Runs in the service worker so backups happen whether or not any extension
 * page is open. Two destinations:
 *
 *   'folder'    — a directory the owner picked, written through a
 *                 FileSystemDirectoryHandle kept in IndexedDB. Anywhere on
 *                 disk, including a Dropbox/Drive/NAS folder. Needs no Chrome
 *                 permission at all.
 *   'downloads' — a subfolder of Downloads via chrome.downloads. Simple and
 *                 never lapses, but chrome.downloads rejects absolute paths and
 *                 `..`, so it genuinely cannot write anywhere else.
 */

import { store, STORAGE_AREA_NAME, STORAGE_KEY } from '../lib/storage.js';
import { createSettingsStore } from '../lib/settings.js';
import { loadDirectoryHandle, directoryPermission } from '../lib/handle-store.js';
import {
  buildExportDocument,
  contentHash,
  toJsonDataUrl,
  backupBasename,
  normalizeSubfolder,
  shouldBackUp,
} from '../lib/backup.js';

export const SWEEP_ALARM = 'promo-backup-sweep';
export const DEBOUNCE_ALARM = 'promo-backup-debounce';

const SWEEP_PERIOD_MINUTES = 60;
// A burst of edits (adding three codes in a row) should produce one backup, not
// three. MV3 clamps alarm delays to 30 seconds minimum.
const DEBOUNCE_MINUTES = 1;

const settingsStore = createSettingsStore(chrome.storage[STORAGE_AREA_NAME]);
export { settingsStore };

/** An error carrying whether a click could fix it. */
class BackupError extends Error {
  /** @param {string} message @param {{needsPermission?: boolean}} [options] */
  constructor(message, options = {}) {
    super(message);
    this.needsPermission = options.needsPermission === true;
  }
}

/**
 * Write into the folder the owner picked.
 * @param {string} payload
 * @param {string} basename
 * @returns {Promise<string>} a path to show in the UI
 */
async function writeToFolder(payload, basename) {
  const dir = await loadDirectoryHandle();
  if (!dir) {
    throw new BackupError('No backup folder chosen yet.', { needsPermission: true });
  }

  const permission = await directoryPermission(dir);
  if (permission !== 'granted') {
    // requestPermission() needs a user gesture, which a service worker woken by
    // an alarm does not have. Surfacing it is the only honest option — the page
    // shows a Reconnect button and the popup's backup nudge comes back.
    throw new BackupError('Chrome needs you to re-approve the backup folder.', {
      needsPermission: true,
    });
  }

  const fileHandle = await dir.getFileHandle(basename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(payload);
  } finally {
    await writable.close();
  }
  return `${dir.name}/${basename}`;
}

/**
 * Write into a subfolder of Downloads.
 * @param {string} payload
 * @param {string} basename
 * @param {string} subfolder
 * @returns {Promise<string>}
 */
async function writeToDownloads(payload, basename, subfolder) {
  const granted = await chrome.permissions.contains({ permissions: ['downloads'] });
  if (!granted) {
    throw new BackupError('The downloads permission was turned off.', { needsPermission: true });
  }

  const folder = normalizeSubfolder(subfolder);
  const filename = folder ? `${folder}/${basename}` : basename;
  await chrome.downloads.download({
    url: toJsonDataUrl(payload),
    filename,
    // One file per day: re-running today replaces today's file and leaves
    // every earlier day alone.
    conflictAction: 'overwrite',
    saveAs: false,
  });
  return `Downloads/${filename}`;
}

/**
 * Run a backup if one is due.
 * @param {{force?: boolean, now?: Date}} [options]
 * @returns {Promise<{status: 'off'|'skipped'|'written'|'failed', reason?: string, path?: string, error?: string}>}
 */
export async function runBackup(options = {}) {
  const now = options.now ?? new Date();
  const settings = await settingsStore.read();

  if (!settings.enabled && !options.force) return { status: 'off' };

  const doc = await store.read();
  const hash = await contentHash(doc);

  const verdict = shouldBackUp(settings, hash, { now, force: options.force });
  if (!verdict.run) return { status: 'skipped', reason: verdict.reason };

  const payload = JSON.stringify(buildExportDocument(doc, now), null, 2);
  const basename = backupBasename(now);

  try {
    const path = settings.destination === 'downloads'
      ? await writeToDownloads(payload, basename, settings.subfolder)
      : await writeToFolder(payload, basename);

    await settingsStore.patch({
      lastRunAt: now.toISOString(),
      lastHash: hash,
      lastPath: path,
      lastError: null,
      needsPermission: false,
    });

    // A backup is a real file on disk, so it counts as an export and quiets the
    // 14-day nudge. If backups start failing, the nudge correctly returns.
    await store.recordExport(now);

    return { status: 'written', path, reason: verdict.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await settingsStore.patch({
      lastError: message,
      needsPermission: error instanceof BackupError ? error.needsPermission : false,
    });
    return { status: 'failed', error: message };
  }
}

/**
 * Schedule the periodic sweep, but only if it is not already scheduled.
 *
 * This runs on every service-worker wake, and the worker wakes on every tab
 * update. `alarms.create` *resets* an existing alarm, so creating it
 * unconditionally would push the sweep back a full period each time a tab
 * loaded — the backup would never fire while the owner was actually browsing.
 */
export async function ensureAlarms() {
  const existing = await chrome.alarms.get(SWEEP_ALARM);
  if (existing) return;
  await chrome.alarms.create(SWEEP_ALARM, {
    periodInMinutes: SWEEP_PERIOD_MINUTES,
    delayInMinutes: 1,
  });
}

/** Coalesce a burst of edits into one backup. */
export function scheduleDebounced() {
  chrome.alarms.create(DEBOUNCE_ALARM, { delayInMinutes: DEBOUNCE_MINUTES });
}

/** Wire up the alarm and data-change triggers. Called once at worker start. */
export function installBackupTriggers() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== SWEEP_ALARM && alarm.name !== DEBOUNCE_ALARM) return;
    void runBackup();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== STORAGE_AREA_NAME || !changes[STORAGE_KEY]) return;
    scheduleDebounced();
  });

  // A browser that was closed when a change landed still gets a backup.
  chrome.runtime.onStartup.addListener(() => {
    void ensureAlarms();
    void runBackup();
  });
  chrome.runtime.onInstalled.addListener(() => {
    void ensureAlarms();
    void runBackup();
  });
}

/** Let the page ask for an immediate backup and hear how it went. */
export function installBackupMessaging() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'promo-backup-now') return undefined;
    runBackup({ force: true }).then(sendResponse);
    return true; // keep the channel open for the async reply
  });
}
