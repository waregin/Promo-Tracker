# Promo Tracker

A personal Chrome extension (Manifest V3) that stores hand-entered promo codes
and badges the toolbar icon when you are on a site you have a code for.

No backend, no accounts, no network calls of any kind. Built to the spec in
`docs/promo-tracker-spec-v2.md`.

---

## Install

1. `git clone` this repo somewhere permanent — Chrome loads the extension from
   this directory every launch, so it cannot be a temp folder.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. **Load unpacked** → pick the repo root (the folder with `manifest.json`).

Pin the icon to the toolbar so you can see the badge. `Ctrl+Shift+Y`
(`Cmd+Shift+Y` on a Mac) opens the popup; rebind it at
`chrome://extensions/shortcuts`.

Updating is `git pull` then the reload arrow on `chrome://extensions`. There is
no build step.

## Using it

**The badge.** When the tab you are on belongs to a vendor you have codes for,
the icon shows how many are still usable. No badge means no active codes — the
badge is the only interruption this extension makes. No notifications, nothing
injected into pages.

**The popup** leads with the codes for the current site, then lists everything
else below. Click **Copy** to put a code on the clipboard, **Mark used** when
you spend one.

**Adding a code** opens a full page rather than a cramped popup, because a popup
closes the moment it loses focus and would eat a half-typed entry. Type a vendor
name that does not exist yet and it asks for a domain right there — no separate
vendor screen.

If you came from a shop, the domain field is prefilled with that site (minus a
leading `www.`, since patterns match subdomains and keeping `www.` would miss
`checkout.…`). If you came from your inbox, it is left blank — saving
`mail.google.com` as a vendor domain would badge your inbox forever.

**Vendors with no website** — a plumber, an electrician, anything booked by
phone or done at the house — are a supported case. Tick **No website** and the
domain fields go away. Those codes never badge a tab, because there is no tab to
badge; they live in the popup under "All my codes" like everything else.

### Expiry is recorded honestly

Four states, and the difference between the middle two is the point:

| You choose | Stored as | Shown as |
|---|---|---|
| Expires on `<date>` | `explicit` | Expires 12 Sep 2026 |
| …and "I worked that date out myself" | `inferred` | Expires 12 Sep 2026 |
| Never expires — the offer says so | `none` | No expiration |
| Nothing was said about expiry *(default)* | `unknown` | No expiration date given |

A missing expiry date is not a promise that the code lasts forever, and the UI
never says it is.

### Notes

One free-text field per code, kept verbatim and never parsed. Use it for
restrictions, who to ask for, whatever matters. (It was called "Terms" in
version 1 of the document format; existing entries migrate automatically.)

### Reusable vs used

`Reusable` means the code works on every order. Marking a reusable code used
increments a counter but never retires it. Marking a single-use code used
retires it, and it drops out of the list and the badge count until you tick
**Show used, expired and archived**.

## Back up your codes

`chrome.storage.local` lives and dies with the extension. Removing it, or
resetting the browser profile, deletes everything. **The JSON export is the only
backup.**

**Backup → Export JSON** downloads `promo-codes-YYYY-MM-DD.json`. Put it
somewhere that is not this browser. The popup starts nagging once it has been
more than 14 days.

Import reads the same file and asks whether to merge or replace:

- **Merge** matches on record id and keeps whichever copy has the later
  `updatedAt`, so importing an old backup cannot roll back newer edits.
- **Replace** discards everything not in the file. It asks first.

A file from a newer document version is refused rather than half-read. Older
ones are migrated on the way in: a v1 export still imports cleanly, with each
promo's `terms` becoming `notes`.

The document is currently **version 2**. The same migration runs against
whatever is already in `chrome.storage`, so upgrading the extension needs no
action from you.

### Where the data lives

`chrome.storage.local`, under the single key `promoData`. On this machine only,
not synced anywhere.

Switching to `chrome.storage.sync` — which roams across Chrome profiles and is
backed up through your Google account, but sits unencrypted in Google's cloud —
is one line, `STORAGE_AREA_NAME` in `src/lib/storage.js`. Nothing else in the
codebase touches a storage area directly. Changing it does **not** migrate what
you already have: export, switch, import.

## Permissions

Two, and no host permissions at all:

- **`storage`** — to save your codes.
- **`tabs`** — to read the current tab's URL. This one is not optional:
  `activeTab` only grants access after you click something, and the badge has to
  update *before* you click. Without `tabs`, `tab.url` comes back empty in
  `tabs.onUpdated`.

There is no `<all_urls>`, no content script, and nothing that can read or change
a page. Hostname matching needs the URL, not the page. Checkout auto-fill is
permanently out of scope, so this never needs to grow.

## Domain matching

A vendor has one or more patterns, each `and subdomains` (default) or `exactly`.

`chewy.com` with `and subdomains` matches `chewy.com`, `www.chewy.com` and
`checkout.chewy.com` — but **not** `notchewy.com` or `evilchewy.com`. It is a
label-boundary check, not `String.endsWith`, which would hand a lookalike site
your codes. That is the single most-tested thing in the repo.

Patterns are cleaned up on entry, so pasting `https://www.chewy.com/deals?x=1`,
`*.chewy.com` or `CHEWY.com/` all store the right thing. Internationalised
domains are converted to punycode so they match what the browser reports.

If several patterns match, the most specific wins: longest pattern first, and
`exactly` beats `and subdomains` at equal length. A vendor with no patterns at
all never matches anything, which is exactly what a no-website vendor wants.

## Development

```sh
npm test          # 61 unit tests, no dependencies, no install needed
npm run typecheck # tsc --noEmit over src/ (JSDoc types, checkJs)
npm run icons     # regenerate icons/*.png from scripts/make-icons.mjs
```

`npm test` needs nothing but Node. The end-to-end suite drives a real Chromium
with the extension loaded and checks the things only a browser can prove —
badge counts on real tabs, the lookalike-domain gate, export downloads, import
merge:

```sh
npm install --no-save playwright
npx playwright install chromium
npm run test:e2e   # 53 checks
```

### Layout

```
manifest.json
src/lib/          pure logic, all unit-tested, no chrome.* at import time
  domains.js        hostname ↔ pattern matching
  status.js         derived status (active / spent / expired / archived)
  format.js         display strings, including the four expiry states
  schema.js         document shape, defaults, validation, merge
  store.js          document store over an injected storage area
  storage.js        the single storage-area accessor
src/background/   service worker: badge painting
src/popup/        the popup
src/page/         list, entry form, vendor management, backup
src/ui/           shared DOM helpers, promo card, export/import, tab context
test/             unit tests; test/e2e/ needs Playwright
```

The service worker holds no state in memory. MV3 kills it when idle, so every
event re-reads storage — at this data size that read is free, and it removes a
whole class of stale-state bugs.

## Scope

Deliberately absent, permanently: auto-applying codes at checkout, any
checkout-form detection, price tracking, deal discovery.

Deliberately absent for now: email capture, any server component, expiry digest
emails, phone support.

The JSON export shape is versioned so it can become the import format for
something larger later. Nothing else in here anticipates that.
