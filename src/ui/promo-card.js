/**
 * The promo card, shared by the popup and the full page so the two can never
 * drift on how a code is presented.
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
    flash(button, 'Press ⌘/Ctrl+C');
    const codeNode = button.parentElement?.querySelector('.code-text');
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

  const header = el('div', { class: 'card-header' }, [
    el('div', { class: 'card-heading' }, [
      handlers.showVendor && vendor
        ? el('span', { class: 'vendor-name', text: vendor.name })
        : null,
      el('span', { class: 'promo-title', text: promo.title || 'Untitled offer' }),
    ]),
    label ? el('span', { class: `chip chip-${status}`, text: label }) : null,
  ]);

  const codeRow = promo.code
    ? el('div', { class: 'code-row' }, [
        el('span', { class: 'code-text', text: promo.code }),
        el('button', {
          class: 'copy',
          type: 'button',
          text: 'Copy',
          title: `Copy ${promo.code}`,
          onclick: (/** @type {Event} */ event) =>
            copy(promo.code, /** @type {HTMLElement} */ (event.currentTarget)),
        }),
      ])
    : null;

  const linkRow = promo.landingUrl
    ? el('div', { class: 'link-row' }, [
        el('a', {
          class: 'landing-link',
          href: promo.landingUrl,
          target: '_blank',
          rel: 'noreferrer noopener',
          text: promo.code ? 'Open offer page' : 'Open offer link',
        }),
      ])
    : null;

  const meta = el('div', { class: 'meta' }, [
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
    (promo.useCount ?? 0) > 0
      ? el('span', {
          class: 'tag',
          text: `Used ${promo.useCount}×`,
        })
      : null,
  ]);

  const actions = el('div', { class: 'card-actions' }, [
    handlers.onMarkUsed
      ? el('button', {
          class: 'ghost',
          type: 'button',
          text: 'Mark used',
          onclick: () => handlers.onMarkUsed?.(promo),
        })
      : null,
    handlers.onUnmarkUsed && (promo.useCount ?? 0) > 0
      ? el('button', {
          class: 'ghost',
          type: 'button',
          text: 'Undo use',
          onclick: () => handlers.onUnmarkUsed?.(promo),
        })
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
  ]);

  return el('article', { class: `card card-${status}`, dataset: { promoId: promo.id } }, [
    header,
    codeRow,
    linkRow,
    promo.terms ? el('p', { class: 'terms', text: promo.terms }) : null,
    meta,
    promo.sourceNote ? el('p', { class: 'source', text: promo.sourceNote }) : null,
    actions.childElementCount ? actions : null,
  ]);
}
