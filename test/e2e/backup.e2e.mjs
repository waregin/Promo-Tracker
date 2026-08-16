/**
 * End-to-end checks for automatic backup.
 *
 * Two things a headless browser cannot do, and how they are handled:
 *
 *  - `showDirectoryPicker()` opens a native dialog. So the folder path is
 *    exercised with an OPFS directory handle stashed under the same IndexedDB
 *    key the picker would use. Everything after the pick is the real code:
 *    handle persistence, retrieval from the service worker, the permission
 *    check, and the write itself.
 *  - `chrome.permissions.request()` opens a native prompt and blocks forever.
 *    So the Downloads path runs against a fixture copy of the extension whose
 *    manifest already lists `downloads` as granted. Only the way the permission
 *    was acquired differs; the write path is untouched.
 *
 *   npm run test:e2e:backup
 */

import { chromium } from 'playwright';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const failures = [];
let count = 0;
function check(name, condition, detail) {
  count += 1;
  if (!condition) failures.push(name);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${count} - ${name}${detail === undefined ? '' : `  [${detail}]`}`);
}

/** A copy of the extension with `downloads` already granted. */
function fixtureWithDownloadsGranted() {
  const dir = mkdtempSync(join(tmpdir(), 'promo-fixture-'));
  cpSync(EXTENSION, dir, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes('/.git'),
  });
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.permissions = [...manifest.permissions, 'downloads'];
  delete manifest.optional_permissions;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

async function launch(extensionPath) {
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'promo-bk-')), {
    headless: true,
    channel: 'chromium',
    acceptDownloads: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await new Promise((r) => setTimeout(r, 800));
  return { context, worker, id: new URL(worker.url()).host };
}

const SEED = {
  version: 2,
  exportedAt: null,
  vendors: [{ id: 'v1', name: 'Chewy', domains: [{ pattern: 'chewy.com', matchType: 'suffix' }], notes: null }],
  promos: [{
    id: 'p1', vendorId: 'v1', code: 'SAVE20', landingUrl: null,
    title: '20% off — “sitewide”', notes: 'Used 3× · café ½ price 🎉',
    expiresAt: null, expiryConfidence: 'unknown', reusable: false, stackable: 'unknown',
    useCount: 0, lastUsedAt: null, archived: false, sourceNote: null,
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
  }],
};

/* ================================================================== *
 * Folder destination
 * ================================================================== */

{
  const { context, worker, id } = await launch(EXTENSION);
  const page = await context.newPage();
  page.on('pageerror', (e) => { failures.push(`page error: ${e.message}`); console.log('FAIL - page error:', e.message); });
  await page.goto(`chrome-extension://${id}/src/page/page.html#data`);
  await page.waitForSelector('#auto-panel');

  check('the backup panel renders', await page.locator('#auto-panel').isVisible());
  check('automatic backup is off by default', !(await page.locator('#auto-enabled').isChecked()));
  check('destination options are hidden while it is off', await page.locator('#auto-options').isHidden());

  // Seed data, stash an OPFS directory where the picker would have put one, and
  // turn on folder backups.
  await page.evaluate((seed) => chrome.storage.local.set({ promoData: seed }), SEED);
  const stashed = await worker.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('PromoBackups', { create: true });
    const db = await new Promise((resolve, reject) => {
      const rq = indexedDB.open('promo-tracker', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('handles');
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(dir, 'backupDirectory');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return dir.name;
  });
  check('a directory handle can be persisted to IndexedDB', stashed === 'PromoBackups');

  await page.evaluate(() => chrome.storage.local.set({
    promoBackupSettings: {
      enabled: true, destination: 'folder', subfolder: 'promo-tracker',
      folderName: 'PromoBackups', lastRunAt: null, lastHash: null,
      lastPath: null, lastError: null, needsPermission: false,
    },
  }));

  // The real path: page → runtime message → service worker → handle → file.
  const first = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'promo-backup-now' }));
  check('a backup is written to the chosen folder', first?.status === 'written', JSON.stringify(first));
  check('the reported path names the folder', /^PromoBackups\/promo-codes-\d{4}-\d{2}-\d{2}\.json$/.test(first?.path ?? ''), first?.path);

  const written = await worker.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('PromoBackups');
    const names = [];
    for await (const name of dir.keys()) names.push(name);
    const file = await (await dir.getFileHandle(names[0])).getFile();
    return { names, text: await file.text() };
  });
  check('exactly one file was created', written.names.length === 1, written.names.join(','));
  check('named by date', /^promo-codes-\d{4}-\d{2}-\d{2}\.json$/.test(written.names[0]), written.names[0]);

  const parsed = JSON.parse(written.text);
  check('the file is the export shape', parsed.version === 2 && Array.isArray(parsed.promos));
  check('it carries the codes', parsed.promos.length === 1 && parsed.promos[0].code === 'SAVE20');
  check('non-ASCII text survives the round trip', parsed.promos[0].notes === 'Used 3× · café ½ price 🎉');
  check('the title round trips too', parsed.promos[0].title === '20% off — “sitewide”');

  // The scheduler skips unchanged data by comparing this hash; the decision
  // itself is unit-tested in test/backup.test.js.
  const afterFirst = await page.evaluate(async () => (await chrome.storage.local.get('promoBackupSettings')).promoBackupSettings);
  check('the content hash is recorded so the sweep can skip', /^[0-9a-f]{64}$/.test(afterFirst.lastHash ?? ''), afterFirst.lastHash?.slice(0, 12));
  check('the run time is recorded', typeof afterFirst.lastRunAt === 'string');
  check('no error was recorded', afterFirst.lastError === null);

  // A successful backup counts as an export, so the 14-day nudge goes quiet.
  const doc = await page.evaluate(async () => (await chrome.storage.local.get('promoData')).promoData);
  check('a backup stamps exportedAt', typeof doc.exportedAt === 'string');

  // Losing the folder must be loud, not silent.
  await worker.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const rq = indexedDB.open('promo-tracker', 1);
      rq.onsuccess = () => resolve(rq.result);
    });
    await new Promise((resolve) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').delete('backupDirectory');
      tx.oncomplete = resolve;
    });
    db.close();
  });
  const lost = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'promo-backup-now' }));
  check('a lost folder fails loudly', lost?.status === 'failed', JSON.stringify(lost));

  const settings = await page.evaluate(async () => (await chrome.storage.local.get('promoBackupSettings')).promoBackupSettings);
  check('the failure is recorded', Boolean(settings.lastError), settings.lastError);
  check('and marked as fixable by a click', settings.needsPermission === true);

  await page.reload();
  await page.waitForSelector('#auto-panel');
  check('the UI offers a Reconnect button', await page.locator('#reconnect-folder').isVisible());
  check('the UI shows the error', await page.locator('#auto-error').isVisible());

  await context.close();
}

/* ================================================================== *
 * Downloads destination
 * ================================================================== */

{
  const fixture = fixtureWithDownloadsGranted();
  const { context, worker, id } = await launch(fixture);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/src/page/page.html#data`);
  await page.waitForSelector('#auto-panel');

  await page.evaluate((seed) => chrome.storage.local.set({ promoData: seed }), SEED);
  await page.evaluate(() => chrome.storage.local.set({
    promoBackupSettings: {
      enabled: true, destination: 'downloads', subfolder: 'promo-tracker',
      folderName: null, lastRunAt: null, lastHash: null,
      lastPath: null, lastError: null, needsPermission: false,
    },
  }));

  const result = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'promo-backup-now' }));
  check('a backup is written to Downloads', result?.status === 'written', JSON.stringify(result));
  check('the path is under the chosen subfolder',
    /^Downloads\/promo-tracker\/promo-codes-\d{4}-\d{2}-\d{2}\.json$/.test(result?.path ?? ''), result?.path);

  const records = await worker.evaluate(() => chrome.downloads.search({}));
  check('Chrome recorded the download', records.length >= 1, `${records.length} record(s)`);

  // Subfolder normalization must reach the actual write.
  await page.evaluate(() => chrome.storage.local.set({
    promoBackupSettings: {
      enabled: true, destination: 'downloads', subfolder: '../../escape',
      folderName: null, lastRunAt: null, lastHash: null,
      lastPath: null, lastError: null, needsPermission: false,
    },
  }));
  const escaped = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'promo-backup-now' }));
  check('a path trying to escape Downloads is sanitised, not rejected',
    escaped?.status === 'written' && /^Downloads\/escape\//.test(escaped.path ?? ''), escaped?.path);

  await context.close();
}

/* ================================================================== *
 * The Firefox shape of things, simulated
 *
 * No Firefox build is available in this environment, so the engine
 * difference that matters — no File System Access API — is simulated by
 * removing those globals in Chromium. It proves the branching, not Firefox
 * itself; see the README for what still needs checking by hand there.
 * ================================================================== */

{
  const { context, worker, id } = await launch(EXTENSION);
  const page = await context.newPage();
  // Strip the API before any extension script runs, as Firefox would.
  await page.addInitScript(() => {
    delete window.showDirectoryPicker;
    delete window.FileSystemDirectoryHandle;
  });
  await page.goto(`chrome-extension://${id}/src/page/page.html#data`);
  await page.waitForSelector('#auto-panel');
  await page.evaluate(() => chrome.storage.local.set({
    promoBackupSettings: {
      enabled: true, destination: 'folder', subfolder: 'promo-tracker',
      folderName: null, lastRunAt: null, lastHash: null,
      lastPath: null, lastError: null, needsPermission: false,
    },
  }));
  await page.reload();
  await page.waitForSelector('#auto-panel');
  await page.waitForTimeout(400);

  check('without the picker, the folder option is hidden',
    await page.locator('#folder-choice').isHidden());
  check('and the reason is explained',
    await page.locator('#no-folder-note').isVisible());
  check('the Downloads subfolder field is shown instead',
    await page.locator('#downloads-block').isVisible());

  // And the background refuses a folder write with a message that says what to do.
  await worker.evaluate(() => { delete globalThis.FileSystemDirectoryHandle; });
  const refused = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'promo-backup-now' }));
  check('a folder write is refused with an actionable message',
    refused?.status === 'failed' && /Downloads subfolder/.test(refused.error ?? ''), refused?.error);

  await context.close();
}

console.log(`\n# ${count - failures.length}/${count} passed`);
if (failures.length) {
  console.log(`# failed: ${failures.join(' | ')}`);
  process.exit(1);
}
