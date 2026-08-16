/**
 * The full page: list, entry form, vendor management, backup.
 *
 * It lives in a tab rather than the popup because a popup closes the moment it
 * loses focus, and losing a half-typed entry is the fastest way to make the
 * owner stop using this (spec §4: entry friction is the real risk).
 */

import { api, supportsDirectoryPicker } from '../lib/api.js';
import { store, STORAGE_AREA_NAME, STORAGE_KEY } from '../lib/storage.js';
import { normalizeDomainPattern } from '../lib/domains.js';
import { derivePromoStatus, isActive } from '../lib/status.js';
import { daysSince, formatDate } from '../lib/format.js';
import { $, el, replaceChildren } from '../ui/dom.js';
import { promoCard } from '../ui/promo-card.js';
import { pageContextHost, isLikelyVendorHost, suggestPattern } from '../ui/tab-context.js';
import { downloadExport, readImportFile, mergeDocuments } from '../ui/transfer.js';
import { createSettingsStore } from '../lib/settings.js';
import { saveDirectoryHandle, loadDirectoryHandle, directoryPermission } from '../lib/handle-store.js';
import { normalizeSubfolder } from '../lib/backup.js';

const SECTIONS = ['codes', 'add', 'vendors', 'data'];

const settingsStore = createSettingsStore(api.storage[STORAGE_AREA_NAME]);

const state = {
  /** @type {any} */ doc: { version: 1, exportedAt: null, vendors: [], promos: [] },
  /** @type {any} */ settings: null,
  /** @type {string|null} */ contextHost: null,
  /** @type {string|null} */ editingPromoId: null,
  /** @type {any} */ pendingImport: null,
  section: 'codes',
};

/* ------------------------------------------------------------------ *
 * Domain row widget — shared by the new-vendor block and vendor cards
 * ------------------------------------------------------------------ */

/**
 * @param {HTMLElement} container
 * @param {string} [pattern]
 * @param {string} [matchType]
 */
function addDomainRow(container, pattern = '', matchType = 'suffix') {
  const input = /** @type {HTMLInputElement} */ (el('input', {
    type: 'text',
    class: 'mono domain-pattern',
    placeholder: 'chewy.com',
    value: pattern,
  }));
  const select = el('select', { class: 'domain-match' }, [
    el('option', { value: 'suffix', text: 'and subdomains', selected: matchType !== 'exact' }),
    el('option', { value: 'exact', text: 'exactly', selected: matchType === 'exact' }),
  ]);
  const row = el('div', { class: 'domain-row' }, [
    /** @type {HTMLElement} */ (input),
    select,
    el('button', {
      type: 'button',
      class: 'ghost',
      text: '✕',
      title: 'Remove this domain',
      onclick: () => {
        row.remove();
        if (!container.children.length) addDomainRow(container);
      },
    }),
  ]);
  container.append(row);
  return input;
}

/**
 * @param {HTMLElement} container
 * @returns {{pattern: string, matchType: string}[]}
 */
function readDomainRows(container) {
  const rows = [];
  for (const row of container.querySelectorAll('.domain-row')) {
    const raw = /** @type {HTMLInputElement} */ (row.querySelector('.domain-pattern')).value;
    const pattern = normalizeDomainPattern(raw);
    if (!pattern) continue;
    const matchType = /** @type {HTMLSelectElement} */ (row.querySelector('.domain-match')).value;
    rows.push({ pattern, matchType });
  }
  return rows;
}

/** @param {HTMLElement} container @param {string} host */
function fillFirstEmptyDomain(container, host) {
  const inputs = /** @type {HTMLInputElement[]} */ ([...container.querySelectorAll('.domain-pattern')]);
  const target = inputs.find((i) => i.value.trim() === '') ?? addDomainRow(container);
  target.value = host;
  target.focus();
}

/* ------------------------------------------------------------------ *
 * Codes list
 * ------------------------------------------------------------------ */

function sortForDisplay(promos) {
  const now = new Date();
  const rank = { active: 0, expired: 1, spent: 2, archived: 3 };
  return [...promos].sort((a, b) => {
    const byStatus = rank[derivePromoStatus(a, now)] - rank[derivePromoStatus(b, now)];
    if (byStatus !== 0) return byStatus;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
}

function renderCodes() {
  const now = new Date();
  const showInactive = /** @type {HTMLInputElement} */ ($('#codes-show-inactive')).checked;
  const vendorsById = new Map(state.doc.vendors.map((v) => [v.id, v]));
  const visible = showInactive ? state.doc.promos : state.doc.promos.filter((p) => isActive(p, now));

  if (!state.doc.promos.length) {
    replaceChildren($('#codes-list'), [
      el('div', { class: 'empty' }, [
        el('p', { text: 'No codes saved yet.' }),
        el('button', { class: 'primary', type: 'button', text: 'Add your first code', onclick: () => go('add') }),
      ]),
    ]);
    return;
  }

  if (!visible.length) {
    replaceChildren($('#codes-list'), [
      el('div', { class: 'empty' }, [
        el('p', { text: 'Nothing active. Tick the box above to see used, expired and archived codes.' }),
      ]),
    ]);
    return;
  }

  replaceChildren(
    $('#codes-list'),
    sortForDisplay(visible).map((promo) =>
      promoCard(promo, vendorsById.get(promo.vendorId), {
        now,
        showVendor: true,
        onMarkUsed: (p) => store.markUsed(p.id).then(refresh),
        onUnmarkUsed: (p) => store.unmarkUsed(p.id).then(refresh),
        onEdit: (p) => startEdit(p),
        onArchive: (p) => store.updatePromo(p.id, { archived: !p.archived }).then(refresh),
      }),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Entry form
 * ------------------------------------------------------------------ */

/** Existing vendor whose name matches what is typed, ignoring case. */
function matchTypedVendor() {
  const typed = /** @type {HTMLInputElement} */ ($('#f-vendor')).value.trim().toLowerCase();
  if (!typed) return null;
  return state.doc.vendors.find((v) => v.name.trim().toLowerCase() === typed) ?? null;
}

function syncVendorField() {
  const typed = /** @type {HTMLInputElement} */ ($('#f-vendor')).value.trim();
  const existing = matchTypedVendor();
  const block = $('#new-vendor-block');
  const hint = $('#vendor-hint');

  if (!typed) {
    block.hidden = true;
    hint.textContent = '';
    return;
  }

  if (existing) {
    block.hidden = true;
    const patterns = existing.domains.map((d) => d.pattern).join(', ');
    const count = state.doc.promos.filter((p) => p.vendorId === existing.id).length;
    hint.textContent = patterns
      ? `Existing vendor · ${patterns} · ${count} code${count === 1 ? '' : 's'}`
      : `Existing vendor · no website · ${count} code${count === 1 ? '' : 's'}`;
    return;
  }

  hint.textContent = 'New vendor — say where its codes work below.';
  if (block.hidden) {
    block.hidden = false;
    const rows = $('#domain-rows');
    if (!rows.children.length) {
      // Prefill from the tab the owner came from, but not when that tab is a
      // webmail host — they are usually reading the offer email, and saving
      // mail.google.com as a vendor domain would badge the inbox forever.
      const prefill = isLikelyVendorHost(state.contextHost) ? suggestPattern(state.contextHost) : '';
      addDomainRow(rows, prefill);
    }
  }
}

/**
 * Some vendors have no website at all — a plumber, a handyman, anything booked
 * by phone or done at the house. Those still deserve a record; they simply
 * never badge a tab.
 */
function syncNoWebsite() {
  const noWebsite = /** @type {HTMLInputElement} */ ($('#f-no-website')).checked;
  $('#website-fields').hidden = noWebsite;
  $('#no-website-hint').hidden = !noWebsite;
}

function syncExpiryControls() {
  const choice = /** @type {HTMLInputElement} */ (
    document.querySelector('input[name="expiry"]:checked')
  )?.value;
  const dateInput = /** @type {HTMLInputElement} */ ($('#f-expires'));
  dateInput.disabled = choice !== 'explicit';
  $('#inferred-wrap').hidden = choice !== 'explicit';
}

function resetForm() {
  state.editingPromoId = null;
  /** @type {HTMLFormElement} */ ($('#promo-form')).reset();
  replaceChildren($('#domain-rows'), []);
  $('#new-vendor-block').hidden = true;
  $('#vendor-hint').textContent = '';
  syncNoWebsite();
  $('#form-heading').textContent = 'Add a code';
  $('#form-submit').textContent = 'Save code';
  $('#form-cancel').hidden = true;
  $('#form-error').hidden = true;
  syncExpiryControls();
}

/** @param {object} promo */
function startEdit(promo) {
  go('add');
  resetForm();
  state.editingPromoId = promo.id;

  const vendor = state.doc.vendors.find((v) => v.id === promo.vendorId);
  /** @type {HTMLInputElement} */ ($('#f-vendor')).value = vendor?.name ?? '';
  /** @type {HTMLInputElement} */ ($('#f-code')).value = promo.code ?? '';
  /** @type {HTMLInputElement} */ ($('#f-landing')).value = promo.landingUrl ?? '';
  /** @type {HTMLInputElement} */ ($('#f-title')).value = promo.title ?? '';
  /** @type {HTMLTextAreaElement} */ ($('#f-notes')).value = promo.notes ?? '';
  /** @type {HTMLInputElement} */ ($('#f-source')).value = promo.sourceNote ?? '';
  /** @type {HTMLInputElement} */ ($('#f-reusable')).checked = promo.reusable === true;
  /** @type {HTMLSelectElement} */ ($('#f-stackable')).value = promo.stackable ?? 'unknown';

  const confidence = promo.expiryConfidence ?? 'unknown';
  const radioValue = confidence === 'none' ? 'none' : promo.expiresAt ? 'explicit' : 'unknown';
  const radio = /** @type {HTMLInputElement} */ (
    document.querySelector(`input[name="expiry"][value="${radioValue}"]`)
  );
  if (radio) radio.checked = true;
  /** @type {HTMLInputElement} */ ($('#f-expires')).value = promo.expiresAt ?? '';
  /** @type {HTMLInputElement} */ ($('#f-inferred')).checked = confidence === 'inferred';

  $('#form-heading').textContent = 'Edit code';
  $('#form-submit').textContent = 'Save changes';
  $('#form-cancel').hidden = false;
  syncVendorField();
  syncExpiryControls();
}

/** @param {string|null} message */
function showFormError(message) {
  const node = $('#form-error');
  node.hidden = !message;
  node.textContent = message ?? '';
  if (message) node.scrollIntoView({ block: 'nearest' });
}

async function submitForm(event) {
  event.preventDefault();
  showFormError(null);

  const vendorName = /** @type {HTMLInputElement} */ ($('#f-vendor')).value.trim();
  const code = /** @type {HTMLInputElement} */ ($('#f-code')).value.trim();
  const landingUrl = /** @type {HTMLInputElement} */ ($('#f-landing')).value.trim();

  if (!vendorName) return showFormError('Which vendor is this for?');
  if (!code && !landingUrl) return showFormError('Add a code, or an offer link if the offer has no code.');

  let vendor = matchTypedVendor();
  let newVendorDomains = [];
  if (!vendor) {
    const noWebsite = /** @type {HTMLInputElement} */ ($('#f-no-website')).checked;
    newVendorDomains = noWebsite ? [] : readDomainRows($('#domain-rows'));
    if (!noWebsite && !newVendorDomains.length) {
      return showFormError(
        `Add at least one domain for ${vendorName}, or tick “No website” if there is nothing to match.`,
      );
    }
  }

  const choice = /** @type {HTMLInputElement} */ (
    document.querySelector('input[name="expiry"]:checked')
  )?.value ?? 'unknown';
  const dateValue = /** @type {HTMLInputElement} */ ($('#f-expires')).value;
  const inferred = /** @type {HTMLInputElement} */ ($('#f-inferred')).checked;

  let expiresAt = null;
  let expiryConfidence = 'unknown';
  if (choice === 'explicit') {
    if (!dateValue) return showFormError('Pick a date, or choose one of the other expiry options.');
    expiresAt = dateValue;
    expiryConfidence = inferred ? 'inferred' : 'explicit';
  } else if (choice === 'none') {
    expiryConfidence = 'none';
  }

  if (!vendor) {
    vendor = await store.addVendor({ name: vendorName, domains: newVendorDomains });
  }

  const fields = {
    vendorId: vendor.id,
    code: code || null,
    landingUrl: landingUrl || null,
    title: /** @type {HTMLInputElement} */ ($('#f-title')).value.trim(),
    notes: /** @type {HTMLTextAreaElement} */ ($('#f-notes')).value.trim() || null,
    expiresAt,
    expiryConfidence,
    reusable: /** @type {HTMLInputElement} */ ($('#f-reusable')).checked,
    stackable: /** @type {HTMLSelectElement} */ ($('#f-stackable')).value,
    sourceNote: /** @type {HTMLInputElement} */ ($('#f-source')).value.trim() || null,
  };

  const wasEditing = state.editingPromoId;
  if (wasEditing) {
    await store.updatePromo(wasEditing, fields);
  } else {
    await store.addPromo(fields);
  }

  await refresh();

  if (wasEditing) {
    resetForm();
    go('codes');
  } else {
    resetForm();
    $('#form-status').textContent = 'Saved.';
    setTimeout(() => { $('#form-status').textContent = ''; }, 2500);
    /** @type {HTMLInputElement} */ ($('#f-vendor')).focus();
  }
}

/* ------------------------------------------------------------------ *
 * Vendors
 * ------------------------------------------------------------------ */

/** @param {any} vendor */
function vendorCard(vendor) {
  const rows = el('div', { class: 'stack' });
  for (const domain of vendor.domains) addDomainRow(rows, domain.pattern, domain.matchType);
  if (!vendor.domains.length) addDomainRow(rows);

  const nameInput = /** @type {HTMLInputElement} */ (el('input', { type: 'text', value: vendor.name }));
  const notesInput = /** @type {HTMLInputElement} */ (
    el('input', { type: 'text', value: vendor.notes ?? '', placeholder: 'Notes (optional)' })
  );
  const count = state.doc.promos.filter((p) => p.vendorId === vendor.id).length;

  const useCurrent = state.contextHost
    ? el('button', {
        type: 'button',
        class: 'ghost',
        text: `Use ${suggestPattern(state.contextHost)}`,
        onclick: () => fillFirstEmptyDomain(rows, suggestPattern(state.contextHost)),
      })
    : null;

  const status = el('span', { class: 'muted' });

  // A vendor with no domains is a deliberate state, not a broken record: the
  // plumber has no website to match. Emptying the field by accident is not, so
  // saving with no domains requires ticking this.
  const noWebsite = /** @type {HTMLInputElement} */ (
    el('input', { type: 'checkbox', checked: vendor.domains.length === 0 })
  );
  const websiteFields = el('div', { class: 'stack' }, [
    el('div', { class: 'field' }, [el('label', { text: 'Domains' }), rows]),
    el('div', { class: 'row' }, [
      el('button', { type: 'button', class: 'ghost', text: '+ Add domain', onclick: () => addDomainRow(rows) }),
      useCurrent,
    ]),
  ]);
  const syncWebsiteFields = () => {
    websiteFields.hidden = noWebsite.checked;
  };
  noWebsite.addEventListener('change', syncWebsiteFields);
  syncWebsiteFields();

  return el('div', { class: 'panel vendor-card' }, [
    el('div', { class: 'vendor-head' }, [
      el('strong', { text: vendor.name }),
      el('span', {
        class: 'vendor-count',
        text: `${count} code${count === 1 ? '' : 's'}${vendor.domains.length ? '' : ' · never badges'}`,
      }),
    ]),
    el('div', { class: 'field' }, [el('label', { text: 'Name' }), nameInput]),
    el('label', { class: 'inline' }, [noWebsite, 'No website — phone or in person only']),
    websiteFields,
    el('div', { class: 'field' }, [el('label', { text: 'Notes' }), notesInput]),
    el('div', { class: 'row' }, [
      el('button', {
        type: 'button',
        class: 'primary',
        text: 'Save vendor',
        onclick: async () => {
          const name = nameInput.value.trim();
          if (!name) { status.textContent = 'Name cannot be empty.'; return; }
          const domains = noWebsite.checked ? [] : readDomainRows(rows);
          if (!noWebsite.checked && !domains.length) {
            status.textContent = 'Keep at least one domain, or tick “No website”.';
            return;
          }
          await store.updateVendor(vendor.id, { name, domains, notes: notesInput.value.trim() || null });
          await refresh();
        },
      }),
      el('button', {
        type: 'button',
        class: 'danger',
        text: 'Delete',
        onclick: async () => {
          const warning = count
            ? `Delete ${vendor.name} and its ${count} code${count === 1 ? '' : 's'}? This cannot be undone.`
            : `Delete ${vendor.name}?`;
          if (!window.confirm(warning)) return;
          await store.removeVendor(vendor.id);
          await refresh();
        },
      }),
      status,
    ]),
  ]);
}

function renderVendors() {
  if (!state.doc.vendors.length) {
    replaceChildren($('#vendors-list'), [
      el('div', { class: 'empty' }, [
        el('p', { text: 'No vendors yet. They are created for you when you add a code.' }),
        el('button', { class: 'primary', type: 'button', text: 'Add a code', onclick: () => go('add') }),
      ]),
    ]);
    return;
  }
  const sorted = [...state.doc.vendors].sort((a, b) => a.name.localeCompare(b.name));
  replaceChildren($('#vendors-list'), sorted.map(vendorCard));
}

/* ------------------------------------------------------------------ *
 * Backup
 * ------------------------------------------------------------------ */

function renderData() {
  const days = daysSince(state.doc.exportedAt);
  $('#export-state').textContent =
    days === null
      ? 'Never exported.'
      : `Last exported ${formatDate(state.doc.exportedAt)} (${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}).`;

  $('#storage-note').textContent =
    `api.storage.${STORAGE_AREA_NAME}, key "${STORAGE_KEY}" — ${
      STORAGE_AREA_NAME === 'local'
        ? 'this machine only, and gone if the extension is removed.'
        : 'synced through your Google account, unencrypted at rest.'
    }`;
}

/* ---- automatic backup ------------------------------------------------ */

async function renderAutoBackup() {
  const settings = state.settings;
  const canPickFolder = supportsDirectoryPicker();

  // Firefox has no File System Access API, so the folder destination cannot
  // work there. Hide it rather than offering something that would fail.
  $('#folder-choice').hidden = !canPickFolder;
  $('#no-folder-note').hidden = canPickFolder;

  /** @type {HTMLInputElement} */ ($('#auto-enabled')).checked = settings.enabled;
  $('#auto-options').hidden = !settings.enabled;

  const radio = /** @type {HTMLInputElement} */ (
    document.querySelector(`input[name="destination"][value="${settings.destination}"]`)
  );
  if (!canPickFolder) {
    $('#folder-block').hidden = true;
    $('#downloads-block').hidden = false;
  }
  if (radio) radio.checked = true;
  $('#folder-block').hidden = !canPickFolder || settings.destination !== 'folder';
  $('#downloads-block').hidden = canPickFolder && settings.destination !== 'downloads';
  /** @type {HTMLInputElement} */ ($('#auto-subfolder')).value = settings.subfolder;

  // The folder name lives in settings, but whether Chrome still honours the
  // grant has to be asked of the handle itself.
  let folderLabel = settings.folderName ? settings.folderName : 'No folder chosen';
  if (settings.folderName) {
    const handle = await loadDirectoryHandle();
    const permission = handle ? await directoryPermission(handle) : 'denied';
    if (permission !== 'granted') folderLabel = `${settings.folderName} — needs reconnecting`;
  }
  $('#folder-name').textContent = folderLabel;

  const days = daysSince(settings.lastRunAt);
  $('#auto-status').textContent = !settings.lastRunAt
    ? 'Never run.'
    : `Last backup ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}${settings.lastPath ? ` → ${settings.lastPath}` : ''}.`;

  $('#auto-error').hidden = !settings.lastError;
  $('#auto-error').textContent = settings.lastError ?? '';
  $('#reconnect-folder').hidden = !(settings.needsPermission && settings.destination === 'folder');
}

/** Ask for a folder. Must run inside a click — the picker needs a gesture. */
async function pickFolder() {
  if (!supportsDirectoryPicker()) {
    await settingsStore.patch({
      lastError: 'This browser cannot write to a chosen folder. Use a Downloads subfolder instead.',
    });
    await refreshSettings();
    return;
  }

  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'promo-tracker-backup' });
  } catch {
    return; // the owner cancelled
  }

  const permission = await handle.requestPermission?.({ mode: 'readwrite' });
  if (permission !== 'granted') {
    await settingsStore.patch({ lastError: 'Write access to that folder was declined.' });
    await refreshSettings();
    return;
  }

  await saveDirectoryHandle(handle);
  await settingsStore.patch({
    folderName: handle.name,
    destination: 'folder',
    needsPermission: false,
    lastError: null,
  });
  await refreshSettings();
  await backupNow();
}

/** Re-grant a lapsed folder without making the owner pick it again. */
async function reconnectFolder() {
  const handle = await loadDirectoryHandle();
  if (!handle) return pickFolder();
  const permission = await handle.requestPermission?.({ mode: 'readwrite' });
  if (permission !== 'granted') {
    await settingsStore.patch({ lastError: 'Chrome still does not have access to that folder.' });
    await refreshSettings();
    return;
  }
  await settingsStore.patch({ needsPermission: false, lastError: null });
  await refreshSettings();
  await backupNow();
}

/** @param {boolean} enabled */
async function setEnabled(enabled) {
  if (!enabled) {
    await settingsStore.patch({ enabled: false });
    await refreshSettings();
    return;
  }
  if (!supportsDirectoryPicker() && state.settings.destination === 'folder') {
    // The only destination this engine can serve.
    await settingsStore.patch({ enabled: true });
    await refreshSettings();
    await setDestination('downloads');
    return;
  }

  await settingsStore.patch({ enabled: true });
  await refreshSettings();
  if (state.settings.destination === 'folder' && !state.settings.folderName) {
    await pickFolder();
  } else {
    await backupNow();
  }
}

/** @param {'folder'|'downloads'} destination */
async function setDestination(destination) {
  if (destination === 'downloads') {
    // Requested only now, so anyone who never turns this on keeps the
    // two-permission install.
    const granted = await api.permissions.request({ permissions: ['downloads'] });
    if (!granted) {
      await refreshSettings();
      return;
    }
  }
  await settingsStore.patch({ destination, lastError: null, needsPermission: false });
  await refreshSettings();
  if (destination === 'folder' && !state.settings.folderName) {
    await pickFolder();
  } else {
    await backupNow();
  }
}

async function backupNow() {
  $('#auto-status').textContent = 'Backing up…';
  /** @type {any} */
  const result = await api.runtime.sendMessage({ type: 'promo-backup-now' }).catch((error) => ({
    status: 'failed',
    error: String(error?.message ?? error),
  }));
  await refreshSettings();
  if (result?.status === 'written') $('#auto-status').textContent = `Backed up to ${result.path}.`;
  else if (result?.status === 'failed') $('#auto-error').textContent = result.error ?? 'Backup failed.';
}

async function refreshSettings() {
  state.settings = await settingsStore.read();
  state.doc = await store.read();
  renderData();
  await renderAutoBackup();
}

/** @param {{errors: string[], warnings: string[], doc: any}|null} report */
function renderImportReport(report) {
  const box = $('#import-report');
  const actions = $('#import-actions');

  if (!report) {
    box.hidden = true;
    actions.hidden = true;
    replaceChildren(box, []);
    return;
  }

  const children = [];
  for (const error of report.errors) children.push(el('p', { class: 'report-error', text: error }));
  for (const warning of report.warnings) children.push(el('p', { class: 'report-warning', text: warning }));

  const usable = report.errors.length === 0 && report.doc;
  if (usable) {
    children.unshift(
      el('p', {
        text: `Found ${report.doc.vendors.length} vendor${report.doc.vendors.length === 1 ? '' : 's'} and ${report.doc.promos.length} code${report.doc.promos.length === 1 ? '' : 's'}.`,
      }),
    );
  }

  replaceChildren(box, children);
  box.hidden = false;
  actions.hidden = !usable;
}

async function handleImportFile(event) {
  const file = /** @type {HTMLInputElement} */ (event.target).files?.[0];
  if (!file) return;
  const report = await readImportFile(file);
  state.pendingImport = report.errors.length ? null : report.doc;
  renderImportReport(report);
}

function clearImport() {
  state.pendingImport = null;
  /** @type {HTMLInputElement} */ ($('#import-file')).value = '';
  renderImportReport(null);
}

/* ------------------------------------------------------------------ *
 * Routing + boot
 * ------------------------------------------------------------------ */

/** @param {string} section */
function go(section) {
  if (!SECTIONS.includes(section)) section = 'codes';
  state.section = section;
  if (window.location.hash !== `#${section}`) window.location.hash = `#${section}`;

  for (const name of SECTIONS) {
    $(`#section-${name}`).hidden = name !== section;
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', /** @type {HTMLElement} */ (tab).dataset.section === section);
  }
  renderActive();
}

function renderActive() {
  if (state.section === 'codes') renderCodes();
  else if (state.section === 'vendors') renderVendors();
  else if (state.section === 'data') { renderData(); void renderAutoBackup(); }
  else if (state.section === 'add') syncVendorField();
}

async function refresh() {
  state.doc = await store.read();
  renderVendorNames();
  renderActive();
}

function renderVendorNames() {
  replaceChildren(
    $('#vendor-names'),
    state.doc.vendors.map((v) => el('option', { value: v.name })),
  );
}

async function main() {
  state.contextHost = await pageContextHost();

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => go(/** @type {HTMLElement} */ (tab).dataset.section ?? 'codes'));
  }
  window.addEventListener('hashchange', () => go(window.location.hash.slice(1)));

  $('#codes-show-inactive').addEventListener('change', renderCodes);

  $('#f-vendor').addEventListener('input', syncVendorField);
  $('#add-domain').addEventListener('click', () => addDomainRow($('#domain-rows')));
  $('#f-no-website').addEventListener('change', syncNoWebsite);
  $('#promo-form').addEventListener('submit', submitForm);
  $('#form-cancel').addEventListener('click', () => { resetForm(); go('codes'); });
  for (const radio of document.querySelectorAll('input[name="expiry"]')) {
    radio.addEventListener('change', syncExpiryControls);
  }

  if (state.contextHost) {
    const button = $('#use-current-domain');
    button.hidden = false;
    button.textContent = `Use ${state.contextHost}`;
    button.addEventListener('click', () =>
      fillFirstEmptyDomain($('#domain-rows'), suggestPattern(state.contextHost)),
    );
  }

  $('#new-vendor').addEventListener('click', () => {
    go('add');
    resetForm();
    /** @type {HTMLInputElement} */ ($('#f-vendor')).focus();
  });

  $('#do-export').addEventListener('click', async () => {
    const filename = downloadExport(state.doc);
    await store.recordExport();
    await refresh();
    $('#export-state').textContent = `Exported to ${filename}.`;
  });

  $('#auto-enabled').addEventListener('change', (event) =>
    setEnabled(/** @type {HTMLInputElement} */ (event.target).checked));
  for (const radio of document.querySelectorAll('input[name="destination"]')) {
    radio.addEventListener('change', (event) =>
      setDestination(/** @type {any} */ (event.target).value));
  }
  $('#pick-folder').addEventListener('click', pickFolder);
  $('#reconnect-folder').addEventListener('click', reconnectFolder);
  $('#backup-now').addEventListener('click', backupNow);
  $('#auto-subfolder').addEventListener('change', async (event) => {
    const value = normalizeSubfolder(/** @type {HTMLInputElement} */ (event.target).value);
    await settingsStore.patch({ subfolder: value });
    await refreshSettings();
  });

  $('#import-file').addEventListener('change', handleImportFile);
  $('#cancel-import').addEventListener('click', clearImport);
  $('#do-merge').addEventListener('click', async () => {
    if (!state.pendingImport) return;
    await store.replaceAll(mergeDocuments(state.doc, state.pendingImport));
    clearImport();
    await refresh();
    go('codes');
  });
  $('#do-replace').addEventListener('click', async () => {
    if (!state.pendingImport) return;
    const message =
      `Replace all ${state.doc.promos.length} saved code${state.doc.promos.length === 1 ? '' : 's'} ` +
      `with the ${state.pendingImport.promos.length} in this file? Anything not in the file is lost.`;
    if (!window.confirm(message)) return;
    await store.replaceAll({ ...state.pendingImport, exportedAt: state.doc.exportedAt });
    clearImport();
    await refresh();
    go('codes');
  });

  // The popup can change data while this page is open.
  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === STORAGE_AREA_NAME && changes[STORAGE_KEY]) void refresh();
  });

  state.settings = await settingsStore.read();
  resetForm();
  await refresh();
  go(window.location.hash.slice(1) || 'codes');
}

void main();
