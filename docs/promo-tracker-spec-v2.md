# Promo Tracker — Chrome Extension Spec (v2)

**Supersedes:** `promo-tracker-spec.md` (v1). That version assumed high email volume, LLM
extraction, and an `email-os` backend. None of those apply. Ignore it except as a reference
for the eventual email-capture phase.

**Target:** new standalone repo, Chrome extension, Manifest V3
**Backend:** none
**Handoff to:** a fresh Claude Code session

---

## 1. What this is

A personal Chrome extension that stores a small set of hand-entered promo codes and shows a
badge when the owner visits a site they have a code for.

Current real dataset: **7 codes**. This is not a system that needs to scale. It needs to be
correct, fast to enter into, and never lose data.

The owner's existing system is "leave the email in the inbox" plus "a list in a budget
spreadsheet being phased out." This replaces both.

### The one feature that matters

Badge + popup when the current tab's hostname matches a vendor with saved codes. Everything
else is secondary. If the domain matching is wrong, the extension is silently useless, so
that logic gets the most care and the most tests.

---

## 2. Scope

**In scope**
- Manual entry of codes (fast — this is the only capture path)
- Vendor records with one or more domain patterns
- Badge on matching tabs, popup listing matching codes
- "See all my codes" list view, always accessible from the popup
- Click-to-copy
- Mark used / track use count
- JSON export and import

**Out of scope, permanently**
- Auto-applying codes at checkout, or any checkout-form DOM detection
- Price tracking or deal discovery

**Out of scope, deferred**
- Email capture (needs the owner's local LLM stack, a separate project — do not couple)
- Any server component
- Expiry digest emails
- Phone support

---

## 3. Data model

Single JSON document in `chrome.storage.local` under one key, `promoData`. At this volume
there is no reason for anything more elaborate. Version the document so future migrations
are possible.

```
{
  "version": 1,
  "exportedAt": "2026-08-04T00:00:00Z",
  "vendors": [ ... ],
  "promos":  [ ... ]
}
```

### Vendor

| field | type | notes |
|---|---|---|
| `id` | string (uuid) | |
| `name` | string | display name |
| `domains` | array of `{ pattern, matchType }` | `matchType`: `suffix` (default) or `exact` |
| `notes` | string, optional | |

`suffix` matching means `chewy.com` matches `www.chewy.com` and `checkout.chewy.com` but not
`notchewy.com`. Implement it as a label-boundary check, not a naive `String.endsWith` —
`endsWith("chewy.com")` incorrectly matches `evilchewy.com`.

Most vendors will have one domain. Support several because country TLDs and checkout
subdomains are common.

### Promo

| field | type | notes |
|---|---|---|
| `id` | string (uuid) | |
| `vendorId` | string | |
| `code` | string, nullable | null for link-only offers |
| `landingUrl` | string, nullable | required if `code` is null |
| `title` | string | short summary, e.g. "20% off sitewide" |
| `terms` | string, nullable | free text, verbatim — do not parse |
| `expiresAt` | ISO date string, nullable | |
| `expiryConfidence` | enum | `explicit` \| `inferred` \| `none` \| `unknown` |
| `reusable` | boolean | true = usable on every order |
| `stackable` | enum | `yes` \| `no` \| `unknown` |
| `useCount` | integer, default 0 | |
| `lastUsedAt` | ISO date string, nullable | |
| `archived` | boolean, default false | |
| `sourceNote` | string, nullable | where it came from, free text |
| `createdAt`, `updatedAt` | ISO date string | |

### Notes the implementer must not simplify away

**`expiryConfidence` has four values, and `none` vs `unknown` is a real distinction.**
- `explicit` — a date was stated
- `inferred` — a relative date ("ends Sunday") was resolved against a known anchor
- `none` — the offer explicitly states it does not expire
- `unknown` — nothing was said about expiry

Default new entries to `unknown`. A missing expiration date is **not** a promise of
permanence, and the form must not conflate the two. This distinction came directly from the
owner's real data: two of seven codes are explicitly non-expiring, and one probably expires
but never said so.

**`reusable` is a boolean, not the inverse of a "used" flag.** One of the owner's codes is
usable on every order indefinitely. `useCount` increments for both kinds; the UI treats a
non-reusable code with `useCount > 0` as spent, and a reusable code's count as informational.

**Derived status** (computed at read time, never stored):
- `spent` — `!reusable && useCount > 0`
- `expired` — `expiresAt` is set and in the past
- `active` — otherwise, and not archived

---

## 4. Behaviour

### Badge

Service worker listens on `chrome.tabs.onUpdated` and `chrome.tabs.onActivated`. On each,
resolve the tab's hostname against the vendor domain list. If the vendor has one or more
`active` promos, set the action badge to that count. Otherwise clear it.

MV3 service workers terminate when idle — hold no state in memory. Read from
`chrome.storage.local` on each event. At this data size that is free.

Badge colour: neutral. No notifications API, no toasts, no injected page banners. The badge
is the entire interruption budget.

### Popup

Two states, same popup:
- **Tab matches a vendor** → that vendor's active codes at the top, each with the code in
  monospace, a copy button, the title, terms, expiry line, and a "mark used" button. Below
  that, a link to the full list.
- **No match** → the full list directly.

The expiry line must render the four confidence states honestly:
- `explicit`/`inferred` → "Expires 12 Sep 2026"
- `none` → "No expiration"
- `unknown` → "No expiration date given" — **not** "No expiration"

Copy button writes to clipboard and gives a brief inline confirmation. No page reload.

### Entry form

One screen. Fields in order: vendor (combobox — pick existing or type a new name), code,
title, expiry (date picker plus a "no expiration stated" / "never expires" pair of choices),
reusable checkbox, terms textarea, source note. Everything except vendor and one of
code/landingUrl is optional.

When a new vendor name is typed, prompt for at least one domain in the same flow. Do not
make the owner visit a separate vendor screen — that friction is the difference between the
system being used and abandoned.

Target: under 30 seconds to add a code from a standing start.

### Vendor management

A simple list where domains can be added, edited, and removed. Include a "use current tab's
domain" shortcut, since the owner will usually be on the site when they realise the pattern
is wrong.

---

## 5. Data durability

`chrome.storage.local` is cleared when the extension is removed. This is the primary risk to
the whole project, because this data currently lives in an inbox and a spreadsheet — both of
which, whatever their flaws, survive a browser profile reset.

Required:
- **Export** button producing a downloaded JSON file named `promo-codes-YYYY-MM-DD.json`,
  matching the document shape in §3.
- **Import** accepting the same shape, with a merge-or-replace choice. Validate `version`.
- The popup's list view shows "Last exported: N days ago" whenever N > 14, as a nudge.

**Storage area decision — confirm with the owner before implementing.**
`chrome.storage.local` (default) keeps everything on the machine. `chrome.storage.sync`
would back the data up through the owner's Google account and roam across Chrome profiles;
7 codes fit trivially inside the 100KB / 8KB-per-item / 512-item limits. But sync storage is
not encrypted and puts the data in Google's cloud, which may run against the owner's
self-hosting direction. Default to `local` unless told otherwise; keep the storage area
behind a single accessor so switching is a one-line change.

---

## 6. Distribution

Start with **load unpacked** from a git checkout (`chrome://extensions` → developer mode →
load unpacked). Free, persists across restarts, shows a periodic developer-mode warning.

If the warning becomes annoying, the alternative is an **unlisted Chrome Web Store listing**:
$5 one-time developer registration, visible only via direct link, gives clean install and
auto-update. Requires passing review, which may ask for privacy details, screenshots, and a
justification for every declared permission — so keep the permission set minimal for this
reason as well as on principle.

Do not pay the $5 up front. Ship load-unpacked first.

---

## 7. Permissions

Request the minimum:
- `storage`
- `tabs` — or preferably `activeTab` plus `tabs.onUpdated` if the URL can be read without
  broad host permissions; verify which is actually needed and take the narrower option
- `clipboardWrite` if required by the copy implementation (`navigator.clipboard` in the popup
  may not need it)

**No `host_permissions` for `<all_urls>`.** Hostname matching only needs the tab's URL, not
the ability to read or modify page content. If an approach seems to require content scripts,
it is the wrong approach.

---

## 8. Milestones

**M1 — Storage, entry, list.**
Data module with typed accessors, entry form, list view, copy, mark-used, export, import.
No badge yet.
*Done when:* the owner's 7 real codes are entered and exported to a file.

**M2 — Matching and badge.**
Domain resolution, service worker listeners, badge, contextual popup, vendor management.
*Done when:* visiting each of the owner's vendors shows the correct badge count, and a
lookalike domain (`notchewy.com` vs `chewy.com`) does not match.

**M3 — Polish.**
Export nudge, empty states, keyboard shortcut to open the popup, expiry rendering per §4.

That's the whole build. Do not add features beyond M3 without the owner asking.

---

## 9. Future integration path (do not build)

If this later joins External Brain OS, the migration is: the JSON export shape in §3 becomes
the import format for a promo module elsewhere, and the extension flips from
`chrome.storage.local` to fetching from a local API. That is why §5 requires the storage area
to sit behind a single accessor and why the document carries a `version` field. Nothing else
about v1 needs to anticipate it.

---

## 10. Non-negotiables

- `unknown` and `none` expiry are distinct and must render differently.
- New entries default to `unknown` expiry, never `none`.
- Export exists before the extension is used in anger.
- No `<all_urls>` host permission, no content scripts, no checkout detection.
- Suffix domain matching respects label boundaries.
- No server dependency in v1.
