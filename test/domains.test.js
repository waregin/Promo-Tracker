import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeHostname,
  hostnameFromUrl,
  normalizeDomainPattern,
  hostMatchesDomain,
  findMatch,
} from '../src/lib/domains.js';

const suffix = (pattern) => ({ pattern, matchType: 'suffix' });
const exact = (pattern) => ({ pattern, matchType: 'exact' });

test('normalizeHostname strips case, port and the root dot', () => {
  assert.equal(normalizeHostname('WWW.Chewy.com'), 'www.chewy.com');
  assert.equal(normalizeHostname('chewy.com:8443'), 'chewy.com');
  assert.equal(normalizeHostname('chewy.com.'), 'chewy.com');
  assert.equal(normalizeHostname('  chewy.com  '), 'chewy.com');
  assert.equal(normalizeHostname(''), '');
  assert.equal(normalizeHostname(null), '');
});

test('hostnameFromUrl only accepts http(s)', () => {
  assert.equal(hostnameFromUrl('https://www.chewy.com/cart'), 'www.chewy.com');
  assert.equal(hostnameFromUrl('http://chewy.com'), 'chewy.com');
  assert.equal(hostnameFromUrl('chrome://extensions'), null);
  assert.equal(hostnameFromUrl('file:///Users/x/index.html'), null);
  assert.equal(hostnameFromUrl('about:blank'), null);
  assert.equal(hostnameFromUrl('chrome-extension://abc/page.html'), null);
  assert.equal(hostnameFromUrl('not a url'), null);
  assert.equal(hostnameFromUrl(undefined), null);
  assert.equal(hostnameFromUrl(''), null);
});

test('normalizeDomainPattern accepts the many ways a domain gets typed', () => {
  assert.equal(normalizeDomainPattern('chewy.com'), 'chewy.com');
  assert.equal(normalizeDomainPattern('https://www.chewy.com/deals?x=1'), 'www.chewy.com');
  assert.equal(normalizeDomainPattern('*.chewy.com'), 'chewy.com');
  assert.equal(normalizeDomainPattern('.chewy.com'), 'chewy.com');
  assert.equal(normalizeDomainPattern('CHEWY.com/'), 'chewy.com');
  assert.equal(normalizeDomainPattern('chewy.com:443'), 'chewy.com');
  assert.equal(normalizeDomainPattern('user@chewy.com'), 'chewy.com');
  assert.equal(normalizeDomainPattern('   '), '');
  assert.equal(normalizeDomainPattern(undefined), '');
});

test('normalizeDomainPattern punycodes internationalised domains', () => {
  // Tab hostnames arrive punycoded, so patterns have to be stored that way too.
  assert.equal(normalizeDomainPattern('bücher.de'), 'xn--bcher-kva.de');
});

test('suffix matching respects label boundaries', () => {
  // The whole point of spec §3: endsWith() would pass every one of these.
  assert.equal(hostMatchesDomain('chewy.com', suffix('chewy.com')), true);
  assert.equal(hostMatchesDomain('www.chewy.com', suffix('chewy.com')), true);
  assert.equal(hostMatchesDomain('checkout.chewy.com', suffix('chewy.com')), true);
  assert.equal(hostMatchesDomain('a.b.c.chewy.com', suffix('chewy.com')), true);

  assert.equal(hostMatchesDomain('notchewy.com', suffix('chewy.com')), false);
  assert.equal(hostMatchesDomain('evilchewy.com', suffix('chewy.com')), false);
  assert.equal(hostMatchesDomain('chewy.com.evil.example', suffix('chewy.com')), false);
  assert.equal(hostMatchesDomain('chewy.co', suffix('chewy.com')), false);
  assert.equal(hostMatchesDomain('xchewy.com', suffix('chewy.com')), false);
});

test('suffix is the default when matchType is missing or junk', () => {
  assert.equal(hostMatchesDomain('www.chewy.com', { pattern: 'chewy.com' }), true);
  assert.equal(hostMatchesDomain('www.chewy.com', { pattern: 'chewy.com', matchType: 'nonsense' }), true);
  assert.equal(hostMatchesDomain('notchewy.com', { pattern: 'chewy.com' }), false);
});

test('exact matching does not follow subdomains', () => {
  assert.equal(hostMatchesDomain('chewy.com', exact('chewy.com')), true);
  assert.equal(hostMatchesDomain('www.chewy.com', exact('chewy.com')), false);
  assert.equal(hostMatchesDomain('notchewy.com', exact('chewy.com')), false);
});

test('matching normalizes both sides', () => {
  assert.equal(hostMatchesDomain('WWW.Chewy.com', suffix('  https://chewy.com/  ')), true);
  assert.equal(hostMatchesDomain('www.chewy.com.', suffix('chewy.com')), true);
});

test('empty patterns never match', () => {
  assert.equal(hostMatchesDomain('chewy.com', suffix('')), false);
  assert.equal(hostMatchesDomain('chewy.com', suffix('   ')), false);
  assert.equal(hostMatchesDomain('', suffix('chewy.com')), false);
});

test('findMatch resolves a hostname to its vendor', () => {
  const vendors = [
    { id: 'v1', name: 'Chewy', domains: [suffix('chewy.com')] },
    { id: 'v2', name: 'Patagonia', domains: [suffix('patagonia.com'), suffix('patagonia.co.uk')] },
  ];

  assert.equal(findMatch(vendors, 'www.chewy.com')?.vendor.id, 'v1');
  assert.equal(findMatch(vendors, 'patagonia.co.uk')?.vendor.id, 'v2');
  assert.equal(findMatch(vendors, 'shop.patagonia.co.uk')?.vendor.id, 'v2');
  assert.equal(findMatch(vendors, 'notchewy.com'), null);
  assert.equal(findMatch(vendors, 'example.com'), null);
  assert.equal(findMatch(vendors, ''), null);
  assert.equal(findMatch(vendors, null), null);
  assert.equal(findMatch([], 'chewy.com'), null);
  assert.equal(findMatch(undefined, 'chewy.com'), null);
});

test('findMatch prefers the most specific pattern', () => {
  const vendors = [
    { id: 'broad', name: 'Store', domains: [suffix('example.com')] },
    { id: 'narrow', name: 'Store outlet', domains: [suffix('outlet.example.com')] },
  ];
  assert.equal(findMatch(vendors, 'outlet.example.com')?.vendor.id, 'narrow');
  assert.equal(findMatch(vendors, 'www.example.com')?.vendor.id, 'broad');
});

test('findMatch prefers exact over suffix at equal length', () => {
  const vendors = [
    { id: 'a', name: 'Suffix', domains: [suffix('example.com')] },
    { id: 'b', name: 'Exact', domains: [exact('example.com')] },
  ];
  assert.equal(findMatch(vendors, 'example.com')?.vendor.id, 'b');
  // The exact record cannot claim the subdomain, so the suffix one still wins.
  assert.equal(findMatch(vendors, 'www.example.com')?.vendor.id, 'a');
});

test('findMatch tolerates malformed vendor records', () => {
  const vendors = [
    null,
    { id: 'no-domains', name: 'Empty' },
    { id: 'bad-domains', name: 'Bad', domains: [null, { matchType: 'suffix' }, { pattern: '' }] },
    { id: 'ok', name: 'Good', domains: [suffix('chewy.com')] },
  ];
  assert.equal(findMatch(vendors, 'chewy.com')?.vendor.id, 'ok');
  assert.equal(findMatch(vendors, 'other.com'), null);
});
