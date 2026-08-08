/**
 * Export and import (spec §5).
 *
 * The export is the only backup: chrome.storage.local dies with the extension.
 * Download uses an object URL rather than chrome.downloads so the extension
 * does not have to request the `downloads` permission.
 */

import { exportFilename } from '../lib/format.js';
import { normalizeDocument, mergeDocuments, CURRENT_VERSION } from '../lib/schema.js';

/**
 * Build the export document — exactly the shape in spec §3.
 * @param {{version: number, vendors: object[], promos: object[]}} doc
 * @param {Date} [now]
 */
export function buildExportDocument(doc, now = new Date()) {
  return {
    version: CURRENT_VERSION,
    exportedAt: now.toISOString(),
    vendors: doc.vendors,
    promos: doc.promos,
  };
}

/**
 * @param {{version: number, vendors: object[], promos: object[]}} doc
 * @param {Date} [now]
 * @returns {string} the filename written
 */
export function downloadExport(doc, now = new Date()) {
  const payload = JSON.stringify(buildExportDocument(doc, now), null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const filename = exportFilename(now);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Give the download a beat to start before the URL is revoked.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);

  return filename;
}

/**
 * Parse and validate a file the owner picked.
 * @param {File} file
 * @returns {Promise<{ok: boolean, doc: any, errors: string[], warnings: string[]}>}
 */
export async function readImportFile(file) {
  let text;
  try {
    text = await file.text();
  } catch {
    return { ok: false, doc: null, errors: ['Could not read that file.'], warnings: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      doc: null,
      errors: [`That file is not valid JSON (${/** @type {Error} */ (error).message}).`],
      warnings: [],
    };
  }

  return normalizeDocument(parsed);
}

export { mergeDocuments };
