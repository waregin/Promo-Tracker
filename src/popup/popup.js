/**
 * The popup (spec §4).
 *
 * Two states, one document: when the tab matches a vendor, that vendor's active
 * codes come first; either way the full list is right below, so "see all my
 * codes" is always one glance away.
 */

import { store } from '../lib/storage.js';
import { findMatch } from '../lib/domains.js';
import { derivePromoStatus, isActive } from '../lib/status.js';
import { exportNudge } from '../lib/format.js';
import { $, el, replaceChildren } from '../ui/dom.js';
import { promoCard } from '../ui/promo-card.js';
import { activeTabHost, openPage } from '../ui/tab-context.js';

let showInactive = false;
/** @type {string|null} */
let contextHost = null;

/** @param {object[]} promos */
function sortForDisplay(promos) {
  const now = new Date();
  const rank = { active: 0, expired: 1, spent: 2, archived: 3 };
  return [...promos].sort((a, b) => {
    const byStatus = rank[derivePromoStatus(a, now)] - rank[derivePromoStatus(b, now)];
    if (byStatus !== 0) return byStatus;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
}

async function render() {
  const doc = await store.read();
  const now = new Date();
  const vendorsById = new Map(doc.vendors.map((v) => [v.id, v]));

  $('#loading').hidden = true;

  // --- backup nudge ---------------------------------------------------
  const nudge = exportNudge(doc, now);
  $('#nudge').hidden = nudge === null;
  if (nudge) $('#nudge-text').textContent = nudge;

  // --- matched vendor -------------------------------------------------
  const match = contextHost ? findMatch(doc.vendors, contextHost) : null;
  const matchedSection = $('#matched');
  /** @type {Set<string>} */
  const shownAbove = new Set();

  if (match) {
    const matched = doc.promos.filter((p) => p.vendorId === match.vendor.id && isActive(p, now));
    if (matched.length) {
      matchedSection.hidden = false;
      $('#matched-title').textContent = `${match.vendor.name} — ${matched.length} code${matched.length === 1 ? '' : 's'} for this site`;
      replaceChildren(
        $('#matched-list'),
        sortForDisplay(matched).map((promo) => {
          shownAbove.add(promo.id);
          return promoCard(promo, match.vendor, {
            now,
            onMarkUsed: (p) => store.markUsed(p.id).then(render),
          });
        }),
      );
    } else {
      matchedSection.hidden = false;
      $('#matched-title').textContent = `${match.vendor.name} — no active codes right now`;
      replaceChildren($('#matched-list'), [
        el('div', { class: 'empty' }, [
          el('p', { text: 'Every code for this vendor is used, expired, or archived.' }),
          el('button', {
            class: 'primary',
            type: 'button',
            text: 'Add a code',
            onclick: () => openPage('add', contextHost),
          }),
        ]),
      ]);
    }
  } else {
    matchedSection.hidden = true;
  }

  // --- full list ------------------------------------------------------
  const allSection = $('#all');
  allSection.hidden = false;

  const rest = doc.promos.filter((p) => !shownAbove.has(p.id));
  const visible = showInactive ? rest : rest.filter((p) => isActive(p, now));
  const hiddenCount = rest.length - visible.length;

  $('#all-title').textContent = match ? 'All my codes' : `All my codes (${visible.length})`;
  const toggle = /** @type {HTMLButtonElement} */ ($('#toggle-inactive'));
  toggle.hidden = hiddenCount === 0 && !showInactive;
  toggle.textContent = showInactive ? 'Hide inactive' : `Show inactive (${hiddenCount})`;

  if (!doc.promos.length) {
    replaceChildren($('#all-list'), [
      el('div', { class: 'empty' }, [
        el('p', { text: 'No codes yet.' }),
        el('button', {
          class: 'primary',
          type: 'button',
          text: 'Add your first code',
          onclick: () => openPage('add', contextHost),
        }),
      ]),
    ]);
    return;
  }

  if (!visible.length) {
    replaceChildren($('#all-list'), [
      el('div', { class: 'empty' }, [
        el('p', { text: match ? 'Nothing else saved.' : 'No active codes right now.' }),
      ]),
    ]);
    return;
  }

  replaceChildren(
    $('#all-list'),
    sortForDisplay(visible).map((promo) =>
      promoCard(promo, vendorsById.get(promo.vendorId), {
        now,
        showVendor: true,
        onMarkUsed: (p) => store.markUsed(p.id).then(render),
      }),
    ),
  );
}

async function main() {
  contextHost = await activeTabHost();

  $('#add').addEventListener('click', () => openPage('add', contextHost));
  $('#manage').addEventListener('click', () => openPage('codes', contextHost));
  $('#nudge-export').addEventListener('click', () => openPage('data', contextHost));
  $('#toggle-inactive').addEventListener('click', () => {
    showInactive = !showInactive;
    void render();
  });

  await render();
}

void main();
