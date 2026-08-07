/**
 * Hostname resolution against vendor domain patterns.
 *
 * This is the module the whole extension rests on (spec §1): if matching is
 * wrong the badge either never appears or appears on the wrong site, and both
 * failures are silent. Everything here is pure so it can be tested in Node.
 */

/**
 * @typedef {{ pattern: string, matchType: 'suffix'|'exact' }} DomainPattern
 * @typedef {{ id: string, name: string, domains: DomainPattern[], notes: string|null }} Vendor
 */

/**
 * Clean up a hostname taken from a URL or typed by hand: lowercase, no port,
 * no trailing root dot.
 * @param {string} value
 * @returns {string} normalized hostname, or '' if there was nothing usable
 */
export function normalizeHostname(value) {
  let host = String(value ?? '').trim().toLowerCase();
  if (!host) return '';
  host = host.replace(/:\d+$/, '');
  host = host.replace(/\.+$/, '');
  return host;
}

/**
 * Pull the hostname out of a tab URL.
 *
 * Returns null for anything that is not http(s) — chrome://, file://,
 * about:blank, extension pages and the new tab page all land here, and none of
 * them can ever be a vendor.
 * @param {string|undefined|null} url
 * @returns {string|null}
 */
export function hostnameFromUrl(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = normalizeHostname(parsed.hostname);
  return host || null;
}

/**
 * Turn whatever the owner typed into a bare hostname pattern.
 *
 * People paste whole URLs, type `*.chewy.com`, or copy `chewy.com/` out of the
 * address bar. All of those mean the same thing, and silently accepting a
 * pattern that can never match would be a data-entry trap.
 * @param {string} input
 * @returns {string} bare hostname, or '' if nothing usable was in there
 */
export function normalizeDomainPattern(input) {
  let value = String(input ?? '').trim().toLowerCase();
  if (!value) return '';

  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  value = value.replace(/^[^/@]*@/, ''); // userinfo
  value = value.split(/[/?#]/)[0]; // path, query, fragment
  value = value.replace(/^\*\./, ''); // wildcard prefix
  value = value.replace(/^\.+/, ''); // leading dots
  value = normalizeHostname(value);
  if (!value) return '';

  // Round-trip through URL so internationalised domains land in punycode, the
  // same form tab hostnames arrive in. A hostname the parser rejects is kept
  // as-is; validation elsewhere will flag it.
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.hostname) value = normalizeHostname(parsed.hostname);
  } catch {
    /* keep the cleaned string */
  }
  return value;
}

/**
 * True if `pattern` is a suffix of `hostname` on a label boundary.
 *
 * This is deliberately NOT String.endsWith: `endsWith('chewy.com')` is true for
 * `evilchewy.com`, which would hand a lookalike site the owner's codes.
 * @param {string} hostname already normalized
 * @param {string} pattern already normalized
 */
function matchesSuffix(hostname, pattern) {
  if (hostname === pattern) return true;
  return hostname.endsWith(`.${pattern}`);
}

/**
 * @param {string} hostname
 * @param {DomainPattern} domain
 * @returns {boolean}
 */
export function hostMatchesDomain(hostname, domain) {
  const host = normalizeHostname(hostname);
  const pattern = normalizeDomainPattern(domain?.pattern);
  if (!host || !pattern) return false;
  // Anything that is not explicitly 'exact' is treated as 'suffix', which is
  // the documented default in spec §3.
  if (domain?.matchType === 'exact') return host === pattern;
  return matchesSuffix(host, pattern);
}

/**
 * Find the vendor owning a hostname.
 *
 * When several patterns match — `chewy.com` (suffix) and `checkout.chewy.com`
 * (exact) both match the checkout page — the most specific one wins: longest
 * pattern first, and `exact` beats `suffix` at equal length.
 * @param {Vendor[]} vendors
 * @param {string|null|undefined} hostname
 * @returns {{ vendor: Vendor, domain: DomainPattern }|null}
 */
export function findMatch(vendors, hostname) {
  const host = normalizeHostname(hostname ?? '');
  if (!host || !Array.isArray(vendors)) return null;

  /** @type {{ vendor: Vendor, domain: DomainPattern, length: number, exact: boolean }|null} */
  let best = null;
  for (const vendor of vendors) {
    for (const domain of vendor?.domains ?? []) {
      if (!hostMatchesDomain(host, domain)) continue;
      const length = normalizeDomainPattern(domain.pattern).length;
      const exact = domain.matchType === 'exact';
      if (
        !best ||
        length > best.length ||
        (length === best.length && exact && !best.exact)
      ) {
        best = { vendor, domain, length, exact };
      }
    }
  }
  return best ? { vendor: best.vendor, domain: best.domain } : null;
}
