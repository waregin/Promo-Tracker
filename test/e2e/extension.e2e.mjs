/**
 * End-to-end checks against a real Chromium with the extension loaded unpacked.
 *
 * The unit tests cover the pure logic; this covers the parts only a browser can
 * prove — that the service worker paints the right badge on the right tab, that
 * a lookalike domain gets nothing (the M2 done-when gate in spec §8), and that
 * the form, export and import actually work end to end.
 *
 * Not part of `npm test`, because it needs Playwright and a browser:
 *   npm install --no-save playwright && npx playwright install chromium
 *   npm run test:e2e
 */

import { chromium } from 'playwright';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const downloads = mkdtempSync(join(tmpdir(), 'promo-dl-'));

const failures = [];
let count = 0;
function check(name, condition) {
  count += 1;
  if (!condition) failures.push(name);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${count} - ${name}`);
}

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'promo-profile-')), {
  headless: true,
  channel: 'chromium',
  acceptDownloads: true,
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
const extensionId = new URL(worker.url()).host;
const pageUrl = `chrome-extension://${extensionId}/src/page/page.html`;
const popupUrl = `chrome-extension://${extensionId}/src/popup/popup.html`;
check('service worker starts', Boolean(extensionId));

/** Badge text on a freshly opened tab for `url`. */
async function badgeFor(url) {
  const tab = await context.newPage();
  await tab.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await tab.waitForTimeout(900);
  const tabId = await worker.evaluate(async (target) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url && t.url.startsWith(target.replace(/\/$/, '')))?.id ?? null;
  }, url);
  const text = tabId === null
    ? '(no tab)'
    : await worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  await tab.close();
  return text;
}

/* ---------------------------------------------------------------- *
 * Entry form
 * ---------------------------------------------------------------- */

const page = await context.newPage();
page.on('pageerror', (error) => {
  failures.push(`uncaught page error: ${error.message}`);
  console.log('FAIL - uncaught page error:', error.message);
});

await page.goto(`${pageUrl}#add`);
await page.waitForSelector('#promo-form');
await page.fill('#f-vendor', 'Chewy');
await page.waitForSelector('#new-vendor-block:not([hidden])');
check('typing an unknown vendor asks for a domain in the same flow', true);

await page.fill('#domain-rows .domain-pattern', 'https://www.chewy.com/deals'); // pasted URL
await page.fill('#f-code', 'SAVE20');
await page.fill('#f-title', '20% off sitewide');
await page.fill('#f-notes', 'One per customer.');
await page.click('#form-submit');
await page.waitForFunction(() => document.querySelector('#form-status')?.textContent === 'Saved.');

await page.fill('#f-vendor', 'Chewy');
await page.fill('#f-code', 'AUTOSHIP5');
await page.fill('#f-title', '$5 off every autoship');
await page.check('input[name="expiry"][value="none"]');
await page.check('#f-reusable');
await page.click('#form-submit');
await page.waitForFunction(() => document.querySelector('#form-status')?.textContent === 'Saved.');

const stored = await page.evaluate(async () => (await chrome.storage.local.get('promoData')).promoData);
check('both codes saved', stored.promos.length === 2);
check('the second code reused the existing vendor', stored.vendors.length === 1);
check('a pasted URL was reduced to a hostname', stored.vendors[0].domains[0].pattern === 'www.chewy.com');
check('new entries default to unknown expiry', stored.promos[0].expiryConfidence === 'unknown');
check('"never expires" is recorded as none, not unknown', stored.promos[1].expiryConfidence === 'none');
check('reusable is stored', stored.promos[1].reusable === true);

/* ---------------------------------------------------------------- *
 * Expiry rendering (spec §4, §10)
 * ---------------------------------------------------------------- */

await page.goto(`${pageUrl}#codes`);
await page.waitForSelector('.card');
const expiryLines = await page.$$eval('.expiry', (nodes) => nodes.map((n) => n.textContent));
check('unknown renders "No expiration date given"', expiryLines.includes('No expiration date given'));
check('none renders "No expiration"', expiryLines.includes('No expiration'));
check('the two never collapse into the same string', new Set(expiryLines).size === 2);

/* ---------------------------------------------------------------- *
 * Badge — the M2 done-when gate
 * ---------------------------------------------------------------- */

// Only http(s) — a '**/*' pattern would also swallow the extension's own pages.
await context.route(/^https?:\/\//, (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>ok' }),
);

check('badge counts active codes on the vendor site', (await badgeFor('http://www.chewy.com/')) === '2');
// The pasted URL stored `www.chewy.com`, so suffix matching covers that host
// and anything under it — but deliberately not a sibling like checkout.*.
check('badge follows subdomains of the stored pattern',
  (await badgeFor('http://cdn.www.chewy.com/')) === '2');
check('a sibling subdomain outside the stored pattern gets nothing',
  (await badgeFor('http://checkout.chewy.com/')) === '');
check('notchewy.com does not match chewy.com', (await badgeFor('http://notchewy.com/')) === '');
check('evilchewy.com does not match chewy.com', (await badgeFor('http://evilchewy.com/')) === '');
check('an unrelated site gets no badge', (await badgeFor('http://example.com/')) === '');

/* ---------------------------------------------------------------- *
 * Mark used
 * ---------------------------------------------------------------- */

await page.goto(`${pageUrl}#codes`);
await page.waitForSelector('.card');
await page.locator('.card', { hasText: 'SAVE20' }).getByRole('button', { name: 'Mark used' }).click();
await page.waitForTimeout(700);
check('using a single-use code drops the badge count', (await badgeFor('http://www.chewy.com/')) === '1');

await page.goto(`${pageUrl}#codes`);
await page.waitForSelector('.card');
check('a spent code leaves the default list', (await page.locator('.card', { hasText: 'SAVE20' }).count()) === 0);

await page.locator('.card', { hasText: 'AUTOSHIP5' }).getByRole('button', { name: 'Mark used' }).click();
await page.waitForTimeout(700);
check('using a reusable code does not spend it', (await badgeFor('http://www.chewy.com/')) === '1');

await page.check('#codes-show-inactive');
await page.waitForTimeout(200);
check(
  'the spent code is chipped "Used"',
  (await page.locator('.card', { hasText: 'SAVE20' }).locator('.chip').textContent()) === 'Used',
);
await page.uncheck('#codes-show-inactive');

/* ---------------------------------------------------------------- *
 * Export and import
 * ---------------------------------------------------------------- */

await page.goto(`${pageUrl}#data`);
await page.waitForSelector('#do-export');
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 10_000 }),
  page.click('#do-export'),
]);
const filename = download.suggestedFilename();
check('export is named promo-codes-YYYY-MM-DD.json', /^promo-codes-\d{4}-\d{2}-\d{2}\.json$/.test(filename));

const exportPath = join(downloads, filename);
await download.saveAs(exportPath);
const exported = JSON.parse(readFileSync(exportPath, 'utf8'));
check('export carries the document version', exported.version === 2);
check('export stamps exportedAt', typeof exported.exportedAt === 'string');
check('export carries every code', exported.promos.length === 2);
check('export carries the vendor', exported.vendors.length === 1);

await page.setInputFiles('#import-file', exportPath);
await page.waitForSelector('#import-actions:not([hidden])');
await page.click('#do-merge');
await page.waitForTimeout(700);
const merged = await page.evaluate(async () => (await chrome.storage.local.get('promoData')).promoData);
check('re-importing an export does not duplicate', merged.promos.length === 2);
check('re-importing an export does not duplicate vendors', merged.vendors.length === 1);
check(
  'importing an older backup does not undo newer edits',
  merged.promos.find((p) => p.code === 'SAVE20').useCount === 1,
);

const junkPath = join(downloads, 'future.json');
writeFileSync(junkPath, '{"version":99,"vendors":[],"promos":[]}');
await page.goto(`${pageUrl}#data`);
await page.setInputFiles('#import-file', junkPath);
await page.waitForSelector('#import-report:not([hidden])');
check('a future-version file is refused', /version 99/.test(await page.textContent('#import-report')));
check('a refused file offers no import buttons', await page.locator('#import-actions').isHidden());

/* ---------------------------------------------------------------- *
 * Vendor management
 * ---------------------------------------------------------------- */

await page.goto(`${pageUrl}?host=chewy.com#vendors`);
await page.waitForSelector('.vendor-card');
const vendorCard = page.locator('.vendor-card').first();
check(
  'vendor management offers the current tab as a shortcut',
  await vendorCard.getByRole('button', { name: 'Use chewy.com' }).isVisible(),
);

await vendorCard.getByRole('button', { name: '+ Add domain' }).click();
await vendorCard.locator('.domain-pattern').last().fill('https://www.chewy.ca/deals');
await vendorCard.locator('input[type="text"]').first().fill('Chewy Inc');
await vendorCard.getByRole('button', { name: 'Save vendor' }).click();
await page.waitForTimeout(600);

const edited = await page.evaluate(async () => (await chrome.storage.local.get('promoData')).promoData);
check('a vendor can be renamed', edited.vendors[0].name === 'Chewy Inc');
check('a domain can be added and is normalized', edited.vendors[0].domains[1].pattern === 'www.chewy.ca');
check('a newly added domain badges immediately', (await badgeFor('http://www.chewy.ca/')) === '1');
check('its lookalike still does not', (await badgeFor('http://www.chewy.ca.evil.example/')) === '');

await context.unrouteAll();

await page.goto(`${pageUrl}#vendors`);
await page.waitForSelector('.vendor-card');
const onlyVendor = page.locator('.vendor-card').first();
await onlyVendor.locator('.domain-pattern').first().fill('');
await onlyVendor.locator('.domain-pattern').last().fill('');
await onlyVendor.getByRole('button', { name: 'Save vendor' }).click();
await page.waitForTimeout(300);
check('domains cannot be emptied by accident', /at least one domain/.test(await onlyVendor.textContent()));

/* ---------------------------------------------------------------- *
 * A vendor with no website at all
 * ---------------------------------------------------------------- */

await page.goto(`${pageUrl}#add`);
await page.waitForSelector('#promo-form');
await page.fill('#f-vendor', 'Local plumber');
await page.waitForSelector('#new-vendor-block:not([hidden])');
check('domain fields are shown by default', await page.locator('#website-fields').isVisible());

await page.check('#f-no-website');
check('ticking "no website" hides the domain fields', await page.locator('#website-fields').isHidden());

await page.fill('#f-code', 'NEIGHBOUR10');
await page.fill('#f-title', '10% off labour');
await page.click('#form-submit');
await page.waitForFunction(() => document.querySelector('#form-status')?.textContent === 'Saved.');

const withPlumber = await page.evaluate(async () => (await chrome.storage.local.get('promoData')).promoData);
const plumber = withPlumber.vendors.find((v) => v.name === 'Local plumber');
check('a vendor with no website can be saved', Boolean(plumber));
check('and is stored with no domains', plumber.domains.length === 0);
check('its code is stored', withPlumber.promos.some((p) => p.code === 'NEIGHBOUR10'));

// It must never badge anything, but must still be listed.
await context.route(/^https?:\/\//, (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }),
);
check('a domainless vendor badges nothing', (await badgeFor('http://example.org/')) === '');
await context.unrouteAll();

await page.goto(`${pageUrl}#codes`);
await page.waitForSelector('.card');
check('its code still appears in the full list',
  (await page.locator('.card', { hasText: 'NEIGHBOUR10' }).count()) === 1);

await page.goto(`${pageUrl}#vendors`);
await page.waitForSelector('.vendor-card');
const plumberCard = page.locator('.vendor-card', { hasText: 'Local plumber' });
check('vendor management flags that it never badges',
  /never badges/.test(await plumberCard.textContent()));

/* ---------------------------------------------------------------- *
 * Popup
 * ---------------------------------------------------------------- */

const matchedPopup = await context.newPage();
// Only a real popup sees the page beneath it; stub the query so the matched
// branch can be exercised headlessly.
await matchedPopup.addInitScript(() => {
  const real = chrome.tabs.query;
  chrome.tabs.query = async (info) =>
    info?.active ? [{ id: 1, url: 'https://www.chewy.com/cart' }] : real(info);
});
await matchedPopup.goto(popupUrl);
await matchedPopup.waitForSelector('#matched:not([hidden])');
check(
  'the popup leads with the matching vendor',
  /Chewy Inc/.test(await matchedPopup.textContent('#matched-title')),
);
check('matched codes are not repeated in the list below',
  (await matchedPopup.locator('#all-list .card', { hasText: 'AUTOSHIP5' }).count()) === 0);
check('the full list stays reachable from the popup',
  await matchedPopup.locator('#all').isVisible());

const plainPopup = await context.newPage();
await plainPopup.addInitScript(() => {
  const real = chrome.tabs.query;
  chrome.tabs.query = async (info) => (info?.active ? [{ id: 2, url: 'https://example.com/' }] : real(info));
});
await plainPopup.goto(popupUrl);
await plainPopup.waitForSelector('#all:not([hidden])');
check('with no match the popup shows the full list directly',
  await plainPopup.locator('#matched').isHidden());

/* ---------------------------------------------------------------- *
 * New-vendor prefill
 * ---------------------------------------------------------------- */

await page.goto(`${pageUrl}?host=chewy.com#add`);
await page.waitForSelector('#promo-form');
await page.fill('#f-vendor', 'Brand New');
await page.waitForSelector('#new-vendor-block:not([hidden])');
check('the domain prefills from the tab the popup came from',
  (await page.inputValue('#domain-rows .domain-pattern')) === 'chewy.com');

await page.goto(`${pageUrl}?host=mail.google.com#add`);
await page.waitForSelector('#promo-form');
await page.fill('#f-vendor', 'Brand New');
await page.waitForSelector('#new-vendor-block:not([hidden])');
check('but not when that tab is webmail',
  (await page.inputValue('#domain-rows .domain-pattern')) === '');
check('the shortcut is still offered there',
  await page.locator('#use-current-domain').isVisible());

// A `www.` host suggests the bare domain: as a suffix rule, keeping `www.`
// would silently miss checkout.* and every other sibling subdomain.
await page.goto(`${pageUrl}?host=www.rei.com#add`);
await page.waitForSelector('#promo-form');
await page.fill('#f-vendor', 'Another New One');
await page.waitForSelector('#new-vendor-block:not([hidden])');
check('a www. host is suggested as the bare domain',
  (await page.inputValue('#domain-rows .domain-pattern')) === 'rei.com');

await context.close();

console.log(`\n# ${count - failures.length}/${count} passed`);
if (failures.length) {
  console.log(`# failed: ${failures.join(' | ')}`);
  process.exit(1);
}
