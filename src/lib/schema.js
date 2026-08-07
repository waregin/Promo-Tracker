/**
 * The shape of the stored/exported document (spec §3), plus the tolerant
 * normalizer that everything reading untrusted JSON goes through.
 *
 * Import must never throw on a slightly-off file and must never silently drop
 * a code: unknown values fall back to documented defaults and are reported as
 * warnings instead.
 */

import { newId } from './id.js';
import { normalizeDomainPattern } from './domains.js';

export const CURRENT_VERSION = 1;

export const EXPIRY_CONFIDENCE = /** @type {const} */ (['explicit', 'inferred', 'none', 'unknown']);
export const STACKABLE = /** @type {const} */ (['yes', 'no', 'unknown']);
export const MATCH_TYPES = /** @type {const} */ (['suffix', 'exact']);

/** @returns {{version: number, exportedAt: string|null, vendors: object[], promos: object[]}} */
export function emptyDocument() {
  return { version: CURRENT_VERSION, exportedAt: null, vendors: [], promos: [] };
}

function nowIso() {
  return new Date().toISOString();
}

/** @param {unknown} value */
function str(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** @param {unknown} value @param {readonly string[]} allowed @param {string} fallback */
function oneOf(value, allowed, fallback) {
  return allowed.includes(/** @type {string} */ (value)) ? String(value) : fallback;
}

/**
 * Accept the several ways a date can arrive (date-only, full ISO, a Date) and
 * store date-only, which is what the form produces and what offers state.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeDateOnly(value) {
  const text = str(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

/** @param {unknown} value @returns {string|null} */
function normalizeTimestamp(value) {
  const text = str(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * @param {{pattern?: string, matchType?: string}} input
 * @returns {{pattern: string, matchType: 'suffix'|'exact'}|null}
 */
export function makeDomain(input) {
  const pattern = normalizeDomainPattern(input?.pattern ?? '');
  if (!pattern) return null;
  return {
    pattern,
    matchType: /** @type {'suffix'|'exact'} */ (oneOf(input?.matchType, MATCH_TYPES, 'suffix')),
  };
}

/**
 * @param {{id?: string, name?: string, domains?: object[], notes?: string|null}} input
 */
export function makeVendor(input = {}) {
  const domains = [];
  const seen = new Set();
  for (const raw of input.domains ?? []) {
    const domain = makeDomain(raw);
    if (!domain) continue;
    const key = `${domain.matchType}:${domain.pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    domains.push(domain);
  }
  return {
    id: str(input.id) ?? newId(),
    name: str(input.name) ?? 'Untitled vendor',
    domains,
    notes: str(input.notes),
  };
}

/**
 * @param {object} input
 */
export function makePromo(input = {}) {
  const created = normalizeTimestamp(input.createdAt) ?? nowIso();
  const useCount = Number.isFinite(Number(input.useCount))
    ? Math.max(0, Math.trunc(Number(input.useCount)))
    : 0;

  return {
    id: str(input.id) ?? newId(),
    vendorId: str(input.vendorId) ?? '',
    code: str(input.code),
    landingUrl: str(input.landingUrl),
    title: str(input.title) ?? '',
    terms: str(input.terms),
    expiresAt: normalizeDateOnly(input.expiresAt),
    expiryConfidence: oneOf(input.expiryConfidence, EXPIRY_CONFIDENCE, 'unknown'),
    reusable: input.reusable === true,
    stackable: oneOf(input.stackable, STACKABLE, 'unknown'),
    useCount,
    lastUsedAt: normalizeTimestamp(input.lastUsedAt),
    archived: input.archived === true,
    sourceNote: str(input.sourceNote),
    createdAt: created,
    updatedAt: normalizeTimestamp(input.updatedAt) ?? created,
  };
}

/**
 * Future-version documents are refused rather than mangled. Older versions get
 * migrated here as the schema grows; version 1 needs nothing yet.
 * @param {any} doc
 */
function migrate(doc) {
  return doc;
}

/**
 * Normalize any candidate document into the canonical shape.
 *
 * @param {unknown} raw
 * @returns {{ok: boolean, doc: ReturnType<typeof emptyDocument>, errors: string[], warnings: string[]}}
 */
export function normalizeDocument(raw) {
  /** @type {string[]} */ const errors = [];
  /** @type {string[]} */ const warnings = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, doc: emptyDocument(), errors: ['Not a Promo Tracker document.'], warnings };
  }

  const input = /** @type {any} */ (raw);
  const version = Number(input.version);

  if (!Number.isInteger(version) || version < 1) {
    errors.push('Missing or invalid "version" field.');
  } else if (version > CURRENT_VERSION) {
    errors.push(
      `This file is version ${version}, but this extension understands up to version ${CURRENT_VERSION}. Update the extension first.`,
    );
  }
  if (errors.length) {
    return { ok: false, doc: emptyDocument(), errors, warnings };
  }

  const migrated = migrate(input);

  const vendors = [];
  const vendorIds = new Set();
  for (const rawVendor of Array.isArray(migrated.vendors) ? migrated.vendors : []) {
    const vendor = makeVendor(rawVendor);
    if (vendorIds.has(vendor.id)) {
      warnings.push(`Duplicate vendor id ${vendor.id} — kept the first one.`);
      continue;
    }
    if (!vendor.domains.length) {
      warnings.push(`Vendor "${vendor.name}" has no domains, so it will never match a tab.`);
    }
    vendorIds.add(vendor.id);
    vendors.push(vendor);
  }

  const promos = [];
  const promoIds = new Set();
  for (const rawPromo of Array.isArray(migrated.promos) ? migrated.promos : []) {
    const promo = makePromo(rawPromo);
    if (promoIds.has(promo.id)) {
      warnings.push(`Duplicate promo id ${promo.id} — kept the first one.`);
      continue;
    }
    if (!vendorIds.has(promo.vendorId)) {
      // Keeping an orphan would hide it from every view. Surfacing it as a
      // warning is better than losing the code.
      warnings.push(`Promo "${promo.title || promo.code || promo.id}" refers to a missing vendor and was skipped.`);
      continue;
    }
    if (!promo.code && !promo.landingUrl) {
      warnings.push(`Promo "${promo.title || promo.id}" has neither a code nor a landing URL.`);
    }
    promoIds.add(promo.id);
    promos.push(promo);
  }

  return {
    ok: true,
    doc: {
      version: CURRENT_VERSION,
      exportedAt: normalizeTimestamp(migrated.exportedAt),
      vendors,
      promos,
    },
    errors,
    warnings,
  };
}

/**
 * Merge an imported document into the existing one.
 *
 * Records are matched on `id`; on collision the one with the later `updatedAt`
 * wins, so importing an older backup cannot roll back newer edits. Vendors have
 * no `updatedAt`, so an incoming vendor replaces the stored one only if it
 * carries more domains — otherwise the stored record is kept.
 *
 * @param {ReturnType<typeof emptyDocument>} current
 * @param {ReturnType<typeof emptyDocument>} incoming
 */
export function mergeDocuments(current, incoming) {
  const vendors = new Map(current.vendors.map((v) => [v.id, v]));
  for (const vendor of incoming.vendors) {
    const existing = vendors.get(vendor.id);
    if (!existing || vendor.domains.length > existing.domains.length) {
      vendors.set(vendor.id, vendor);
    }
  }

  const promos = new Map(current.promos.map((p) => [p.id, p]));
  for (const promo of incoming.promos) {
    const existing = promos.get(promo.id);
    if (!existing) {
      promos.set(promo.id, promo);
      continue;
    }
    const a = new Date(existing.updatedAt).getTime() || 0;
    const b = new Date(promo.updatedAt).getTime() || 0;
    if (b >= a) promos.set(promo.id, promo);
  }

  // Drop promos whose vendor did not survive the merge.
  const kept = [...promos.values()].filter((p) => vendors.has(p.vendorId));

  return {
    version: CURRENT_VERSION,
    exportedAt: current.exportedAt,
    vendors: [...vendors.values()],
    promos: kept,
  };
}
