/**
 * Working out which site the owner is "on".
 *
 * The popup can just ask for the active tab. The full page cannot — once it
 * opens, IT is the active tab — so the popup passes the hostname along in the
 * URL and the page remembers it for the rest of the session.
 */

import { api } from '../lib/api.js';
import { hostnameFromUrl } from '../lib/domains.js';

const SESSION_KEY = 'promoTrackerContextHost';

/**
 * Hosts where the owner is reading the offer, not shopping. Prefilling a vendor
 * domain with `mail.google.com` would make the vendor match Gmail and badge
 * every visit to the inbox, which is exactly the kind of quiet wrongness §1
 * warns about. The field still accepts it if typed on purpose.
 */
const NON_VENDOR_HOSTS = [
  'mail.google.com',
  'gmail.com',
  'inbox.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'mail.yahoo.com',
  'mail.proton.me',
  'mail.protonmail.com',
  'app.fastmail.com',
  'mail.zoho.com',
];

/** Self-hosted webmail usually lives under one of these leading labels. */
const NON_VENDOR_LABELS = ['roundcube', 'webmail'];

/** @param {string|null} host */
export function isLikelyVendorHost(host) {
  if (!host) return false;
  // Label-boundary checks, for the same reason domain matching uses them:
  // a plain startsWith would write off `gmail.com.br`, and a plain endsWith
  // would write off a vendor whose name happens to end in one of these.
  if (NON_VENDOR_HOSTS.some((bad) => host === bad || host.endsWith(`.${bad}`))) return false;
  if (NON_VENDOR_LABELS.includes(host.split('.')[0])) return false;
  return true;
}

/**
 * Turn the hostname of the tab the owner is on into the pattern they almost
 * certainly mean.
 *
 * Patterns are suffix rules, so a leading `www.` narrows rather than widens:
 * saving `www.chewy.com` off the address bar would quietly miss
 * `checkout.chewy.com`, which is exactly the silent failure spec §1 is about.
 * They mean the site, so suggest the site. The field stays editable, and
 * anyone who really wants www-only can type it back or pick `exactly`.
 * @param {string|null} host
 * @returns {string}
 */
export function suggestPattern(host) {
  if (!host) return '';
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** The active tab's hostname, or null on chrome:// pages and the new tab page. */
export async function activeTabHost() {
  try {
    const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
    return hostnameFromUrl(tab?.url);
  } catch {
    return null;
  }
}

/**
 * Open the full page, handing it the hostname the popup could see.
 * @param {string} [section] hash section, e.g. 'add'
 * @param {string|null} [host]
 */
export async function openPage(section = 'codes', host = null) {
  const base = api.runtime.getURL('src/page/page.html');
  const query = host ? `?host=${encodeURIComponent(host)}` : '';
  await api.tabs.create({ url: `${base}${query}#${section}` });
  window.close();
}

/**
 * The hostname the full page should offer as "current tab": whatever the popup
 * passed, remembered across in-page navigation, falling back to the active tab
 * for the case where the page was opened straight from chrome://extensions.
 * @returns {Promise<string|null>}
 */
export async function pageContextHost() {
  const fromUrl = new URL(window.location.href).searchParams.get('host');
  if (fromUrl) {
    const host = hostnameFromUrl(`https://${fromUrl}`);
    if (host) {
      try {
        sessionStorage.setItem(SESSION_KEY, host);
      } catch { /* private mode */ }
      return host;
    }
  }

  try {
    const remembered = sessionStorage.getItem(SESSION_KEY);
    if (remembered) return remembered;
  } catch { /* private mode */ }

  const active = await activeTabHost();
  // Ignore the extension's own page.
  return active && !active.startsWith(api.runtime.id) ? active : null;
}
