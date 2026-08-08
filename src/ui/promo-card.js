/**
 * The promo card, shared by the popup and the full page so the two can never
 * drift on how a code is presented.
 *
 * Laid out for vertical density: with a handful of codes the popup should not
 * need scrolling, so everything that describes the offer sits on one line and
 * everything that acts on it sits on the next.
 *
 *   Chewy · 20% off sitewide        Expires 12 Sep 2026 · Reusable
 *   SAVE20  [Copy] [Mark used]                    [Edit] [Archive]
 *   <notes, only when there are any>
 */

import { el, flash } from './dom.js';
import { derivePromoStatus } from '../lib/status.js';
import { formatExpiryLine, statusLabel } from '../lib/format.js';

/**
 * @param {string} text
 * @param {HTMLElement} button
 */
async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    flash(button, 'Copied');
  } catch {
    // Clipboard can be refused if the document lost focus. Select the code so
    // the owner can copy it by hand instead of being left with a dead button.
    flash(button, '⌘/Ctrl+C');
    const codeNode = button.closest('.code-row')?.querySelector('.code-text');
    if (codeNode) {
      const range = document.createRange();
      range.selectNodeContents(codeNode);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }
}

/**
 * @param {object} promo
 * @param {{ name: string }|undefined} vendor
 * @param {{
 *   showVendor?: boolean,
 *   onMarkUsed?: (promo: object) => void,
 *   onUnmarkUsed?: (promo: object) => void,
 *   onEdit?: (promo: object) => void,
 *   onArchive?: (promo: object) => void,
 *   now?: Date,
 * }} [handlers]
 */
export function promoCard(promo, vendor, handlers = {}) {
  const now = handlers.now ?? new Date();
  const status = derivePromoStatus(promo, now);
  const label = statusLabel(status);

  /* --- line 1: what the offer is, and everything qualifying it ---------- */

  const description = el('div', { class: 'description' }, [
    handlers.showVendor && vendor
      ? el('span', { class: 'vendor-name', text: vendor.name })
      : null,
    el('span', { class: 'promo-title', text: promo.title || 'Untitled offer' }),
  ]);

  const qualifiers = el('div', { class: 'meta' }, [
    el('span', {
      class: `expiry expiry-${promo.expiryConfidence}`,
      text: formatExpiryLine(promo, now),
      title: promo.expiryConfidence === 'inferred'
        ? 'Date was worked out from a relative deadline, not stated outright.'
        : promo.expiryConfidence === 'unknown'
          ? 'The offer never said whether it expires.'
          : null,
    }),
    promo.reusable ? el('span', { class: 'tag', text: 'Reusable' }) : null,
    promo.stackable === 'yes' ? el('span', { class: 'tag', text: 'Stackable' }) : null,
    promo.stackable === 'no' ? el('span', { class: 'tag', text: 'Not stackable' }) : null,
    (promo.useCount ?? 0) > 0 ? el('span', { class: 'tag', text: `Used ${promo.useCount}×` }) : null,
    label ? el('span', { class: `chip chip-${status}`, text: label }) : null,
  ]);

  /* --- line 2: the code, and what you can do with it -------------------- */

  const primaryActions = [
    promo.code
      ? el('button', {
          class: 'copy',
          type: 'button',
          text: 'Copy',
          title: `Copy ${promo.code}`,
          onclick: (/** @type {Event} */ event) =>
            copy(promo.code, /** @type {HTMLElement} */ (event.currentTarget)),
        })
      : null,
    handlers.onMarkUsed
      ? el('button', {
          class: 'ghost',
          type: 'button',
          text: 'Mark used',
          onclick: () => handlers.onMarkUsed?.(promo),
        })
      : null,
  ].filter(Boolean);

  const secondaryActions = [
    handlers.onUnmarkUsed && (promo.useCount ?? 0) > 0
      ? el('button', { class: 'ghost', type: 'button', text: 'Undo use', onclick: () => handlers.onUnmarkUsed?.(promo) })
      : null,
    handlers.onEdit
      ? el('button', { class: 'ghost', type: 'button', text: 'Edit', onclick: () => handlers.onEdit?.(promo) })
      : null,
    handlers.onArchive
      ? el('button', {
          class: 'ghost',
          type: 'button',
          text: promo.archived ? 'Unarchive' : 'Archive',
          onclick: () => handlers.onArchive?.(promo),
        })
      : null,
  ].filter(Boolean);

  const codeRow = el('div', { class: 'card-line code-row' }, [
    promo.code ? el('span', { class: 'code-text', text: promo.code }) : null,
    promo.landingUrl
      ? el('a', {
          class: 'landing-link',
          href: promo.landingUrl,
          target: '_blank',
          rel: 'noreferrer noopener',
          text: promo.code ? 'Offer page' : 'Open offer link',
        })
      : null,
    ...primaryActions,
    secondaryActions.length ? el('span', { class: 'spacer' }) : null,
    ...secondaryActions,
  ]);

  return el('article', { class: `card card-${status}`, dataset: { promoId: promo.id } }, [
    el('div', { class: 'card-line headline' }, [description, qualifiers]),
    codeRow.childElementCount ? codeRow : null,
    promo.notes ? el('p', { class: 'notes', text: promo.notes }) : null,
    promo.sourceNote ? el('p', { class: 'source', text: promo.sourceNote }) : null,
  ]);
}
