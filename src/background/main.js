/**
 * The background entry point: badge painting (spec §4) and automatic backup.
 *
 * Loaded as an MV3 service worker on Chromium and as an event page on Firefox,
 * which has no service workers in MV3 — the manifest declares both keys and
 * each engine takes the one it understands. Nothing here may assume a DOM.
 *
 * Either way the background context is killed when idle, so nothing is cached
 * in memory: every event re-reads storage. At this data size that read is free,
 * and it removes a whole class of stale-state bugs.
 */

import { api } from '../lib/api.js';
import { store, STORAGE_AREA_NAME, STORAGE_KEY } from '../lib/storage.js';
import { installBackupTriggers, installBackupMessaging, ensureAlarms } from './backup.js';
import { hostnameFromUrl, findMatch } from '../lib/domains.js';
import { countActiveForVendor } from '../lib/status.js';

// Neutral grey. The badge is the entire interruption budget (spec §4) — no
// notifications, no toasts, no injected banners.
const BADGE_BACKGROUND = '#5f6368';
const BADGE_TEXT_COLOR = '#ffffff';

/**
 * @param {string|undefined} url
 * @returns {Promise<{count: number, vendorName: string|null}>}
 */
async function resolve(url) {
  const hostname = hostnameFromUrl(url);
  if (!hostname) return { count: 0, vendorName: null };

  const doc = await store.read();
  const match = findMatch(doc.vendors, hostname);
  if (!match) return { count: 0, vendorName: null };

  return {
    count: countActiveForVendor(doc.promos, match.vendor.id),
    vendorName: match.vendor.name,
  };
}

/**
 * Badge text is set per tab, never globally — a global badge would follow the
 * owner onto every unrelated site.
 * @param {number} tabId
 * @param {string|undefined} url
 */
async function paint(tabId, url) {
  let count = 0;
  let vendorName = null;
  try {
    ({ count, vendorName } = await resolve(url));
  } catch {
    // A storage read can fail while the profile is starting up. Leave the badge
    // alone rather than clearing a correct one.
    return;
  }

  try {
    await api.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
    await api.action.setTitle({
      tabId,
      title: count > 0
        ? `Promo Tracker — ${count} code${count === 1 ? '' : 's'} for ${vendorName}`
        : 'Promo Tracker',
    });
    if (count > 0) {
      await api.action.setBadgeBackgroundColor({ tabId, color: BADGE_BACKGROUND });
      // Not available on older Chrome; the default is readable anyway.
      await api.action.setBadgeTextColor?.({ tabId, color: BADGE_TEXT_COLOR });
    }
  } catch {
    // Tab closed mid-flight. Nothing to do.
  }
}

async function repaintAll() {
  let tabs = [];
  try {
    tabs = await api.tabs.query({});
  } catch {
    return;
  }
  await Promise.all(tabs.map((tab) => (tab.id === undefined ? null : paint(tab.id, tab.url))));
}

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // `url` covers same-document navigation; `status` covers the normal load.
  if (changeInfo.url === undefined && changeInfo.status === undefined) return;
  void paint(tabId, changeInfo.url ?? tab?.url);
});

api.tabs.onActivated.addListener(({ tabId }) => {
  void (async () => {
    try {
      const tab = await api.tabs.get(tabId);
      await paint(tabId, tab?.url);
    } catch {
      /* tab vanished */
    }
  })();
});

// Data changed in the popup or the full page — every open tab's count may be
// stale now.
api.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== STORAGE_AREA_NAME || !changes[STORAGE_KEY]) return;
  void repaintAll();
});

// Badges do not survive an extension reload or a browser restart.
api.runtime.onInstalled.addListener(() => void repaintAll());
api.runtime.onStartup.addListener(() => void repaintAll());

// Automatic backups (spec §5: losing this data is the project's biggest risk).
installBackupTriggers();
installBackupMessaging();
void ensureAlarms();
