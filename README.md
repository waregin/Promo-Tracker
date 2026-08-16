# Promo Tracker

A personal browser extension (Manifest V3) that stores hand-entered promo codes
and badges the toolbar icon when you are on a site you have a code for.

Runs on **LibreWolf and Firefox** and on **Chrome and Chromium**, from one
codebase with no build step. No backend, no accounts, no network calls of any
kind. Built to the spec in `docs/promo-tracker-spec-v2.md`.

---

## Installing on LibreWolf (or Firefox)

### Try it in one minute — temporary

1. `git clone` this repo.
2. Open `about:debugging#/runtime/this-firefox`.
3. **Load Temporary Add-on…** → pick `manifest.json` in the repo root.

Works immediately, but it is gone when you close the browser. Good for a first
look; not how you want to keep it.

### Keep it — permanent

LibreWolf, unlike stock Firefox release builds, lets you install unsigned
extensions:

1. `npm run package` → produces `dist/promo-tracker-1.0.0.xpi`.
2. Open `about:config`, accept the warning, search
   `xpinstall.signatures.required`, and set it to **false**.
3. Open `about:addons` → the gear icon → **Install Add-on From File…** → pick
   the `.xpi`.

If step 2 has no effect on your build — the pref only works where signature
enforcement was compiled out — the alternative is to get the same file signed
for free:

1. Sign in at [addons.mozilla.org](https://addons.mozilla.org/developers/), →
   **Submit a New Add-on** → **On your own** (self-distribution, so it is never
   listed publicly or reviewed for the store).
2. Upload the `.xpi`; you get a signed one back, usually within minutes.
3. Install the signed file the same way, with no `about:config` change.

Either way: pin the icon to the toolbar so you can see the badge.
`Ctrl+Shift+Y` opens the popup; rebind it at `about:addons` → gear → **Manage
Extension Shortcuts**.

To update: `git pull`, `npm run package`, install the new `.xpi` over the old
one. (With a temporary install it is just `git pull` then **Reload** in
`about:debugging`.)

### Moving your codes over from Chrome

The two builds share one data format, and neither talks to the other, so move
the data by hand — once:

1. In Chrome: **Backup → Export JSON**.
2. In LibreWolf: **Backup → Import**, choose the file, then **Replace
   everything**.

Do this before you uninstall the Chrome copy; removing it deletes its storage.

## Installing on Chrome or Chromium

1. `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → pick the repo root.

Updating is `git pull` then the reload arrow. The same `manifest.json` serves
both engines: it declares a background `service_worker` for Chromium and
background `scripts` for Firefox, and each ignores the other's key.

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

### Automatic backup

Off until you turn it on, under **Backup → Automatic backup**. Once on, a
backup is written whenever your codes change (coalesced, at most hourly) and on
an hourly sweep, so a change made just before you closed the browser still gets
saved. One file per day, `promo-codes-YYYY-MM-DD.json`; running again the same
day replaces that day's file, and earlier days are never touched — so a bad
save cannot destroy yesterday's good copy.

Two destinations:

**A folder you choose — Chromium only.** Anywhere on disk, including a Dropbox,
Drive or network folder, which gets the copy off this machine entirely. Uses the
File System Access API, so it needs **no browser permission at all** — you grant
access to that one folder and nothing else.

**Firefox and LibreWolf have no File System Access API**, and no equivalent: the
origin-private file system they do have lives inside the browser profile, which
is exactly where a backup must not be. So on LibreWolf this option is hidden
rather than offered and silently broken, and the destination is:

**A subfolder of your download folder.** The only option on Firefox, and the
sturdier one everywhere — it never lapses. The catch is that no extension may
write outside that folder: the downloads API rejects absolute paths, `~` and
`..` outright. To put backups somewhere else on LibreWolf, either change the
download folder in **Settings → General → Downloads**, or point a symlink at the
subfolder:

```sh
ln -s ~/Documents/PromoBackups ~/Downloads/promo-tracker
```

Choosing this destination asks for the `downloads` permission at that moment.

If Chrome ever drops the folder grant — it can happen between sessions, and a
background worker has no user gesture to re-request it with — backups stop, the
panel says so with a **Reconnect folder** button, and the 14-day export nudge
comes back. That failure is deliberately loud: a backup that has quietly
stopped is worse than no backup.

A successful automatic backup counts as an export, so it quiets the nudge on
its own while it is working.

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

Three, and no host permissions at all — identical on both engines:

- **`storage`** — to save your codes.
- **`tabs`** — to read the current tab's URL. This one is not optional:
  `activeTab` only grants access after you click something, and the badge has to
  update *before* you click. Without `tabs`, `tab.url` comes back empty in
  `tabs.onUpdated`.
- **`alarms`** — to schedule automatic backups. Shows no warning at install.

One optional permission, requested only if you ask for it:

- **`downloads`** — requested at the moment you choose the Downloads destination
  for automatic backup. Never requested otherwise, so if you use the folder
  destination (or no automatic backup at all) it is never granted.

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
npm test          # 88 unit tests, no dependencies, no install needed
npm run typecheck # tsc --noEmit over src/ (JSDoc types, checkJs)
npm run package   # build dist/promo-tracker-<version>.xpi
npm run icons     # regenerate icons/*.png from scripts/make-icons.mjs

npx --yes web-ext lint --source-dir . --self-hosted   # Mozilla's own linter
```

`web-ext lint` reports **0 errors**. Its one warning — that Firefox ignores
`background.service_worker` — is the dual-engine manifest working as intended.

`npm test` needs nothing but Node. The end-to-end suite drives a real Chromium
with the extension loaded and checks the things only a browser can prove —
badge counts on real tabs, the lookalike-domain gate, export downloads, import
merge:

```sh
npm install --no-save playwright
npx playwright install chromium
npm run test:e2e         # 53 checks: matching, badge, entry, export/import
npm run test:e2e:backup  # 29 checks: automatic backup, both destinations
```

### What is not covered

**The end-to-end suites run on Chromium only.** No Firefox build was available
where this was developed, so nothing here has been executed on a Gecko engine.
The shared logic is the same code on both — the 88 unit tests and the 82
Chromium checks exercise all of it — and the manifest passes Mozilla's linter,
but that is not the same as having run.

The one engine difference that changes behaviour, the missing File System Access
API, is covered by deleting those globals in Chromium and asserting the
branching (`test/e2e/backup.e2e.mjs`, final block). That proves the branch, not
Gecko.

So on a first LibreWolf install, check by hand:

1. The toolbar badge shows a count on a vendor site and nothing on a lookalike.
2. Adding a code and copying one both work.
3. Automatic backup writes a file where you expect.
4. `about:debugging` → **Inspect** on the extension → Console is clean.

Two things the backup suite has to work around, both documented at the top of
`test/e2e/backup.e2e.mjs`: `showDirectoryPicker()` and
`chrome.permissions.request()` both open native dialogs that a headless browser
cannot answer. So the folder path is driven with an OPFS directory handle
stashed under the key the picker would use — every line after the pick is the
real code — and the Downloads path runs against a fixture copy of the manifest
with the permission pre-granted.

### Layout

```
manifest.json
src/lib/          pure logic, all unit-tested, no browser API at import time
  api.js            the browser/chrome shim and engine capability checks
  domains.js        hostname ↔ pattern matching
  status.js         derived status (active / spent / expired / archived)
  format.js         display strings, including the four expiry states
  schema.js         document shape, defaults, validation, merge
  backup.js         backup payload, content hashing, scheduling decisions
  settings.js       automatic-backup settings, stored outside the document
  handle-store.js   the backup folder handle, in IndexedDB
  store.js          document store over an injected storage area
  storage.js        the single storage-area accessor
src/background/   main.js — service worker on Chromium, event page on Firefox
src/popup/        the popup
src/page/         list, entry form, vendor management, backup
src/ui/           shared DOM helpers, promo card, export/import, tab context
test/             unit tests; test/e2e/ needs Playwright
```

The background context holds no state in memory. Both engines kill it when idle,
so every event re-reads storage — at this data size that read is free, and it
removes a whole class of stale-state bugs.

Every browser call goes through `api` from `src/lib/api.js`, which prefers
`browser` (promise-based, Firefox) over `chrome` (promise-based on Chromium;
Firefox also defines it, but callback-style). Engine differences are
feature-detected, never sniffed — with one distinction worth knowing:
`supportsDirectoryPicker()` answers "can I show a folder picker here", which is
false in *any* background context, while `supportsFolderWrites()` answers "can I
write through a handle someone already picked", which is true in a Chromium
service worker. Confusing the two silently breaks folder backups.

## Scope

Deliberately absent, permanently: auto-applying codes at checkout, any
checkout-form detection, price tracking, deal discovery.

Deliberately absent for now: email capture, any server component, expiry digest
emails, phone support.

The JSON export shape is versioned so it can become the import format for
something larger later. Nothing else in here anticipates that.
