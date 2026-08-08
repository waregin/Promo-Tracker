import test from 'node:test';
import assert from 'node:assert/strict';

import { isLikelyVendorHost, suggestPattern } from '../src/ui/tab-context.js';

test('webmail hosts are not offered as vendor domains', () => {
  // The owner is normally reading the offer email when they add a code, so the
  // active tab is usually the inbox. Prefilling it would badge the inbox.
  assert.equal(isLikelyVendorHost('mail.google.com'), false);
  assert.equal(isLikelyVendorHost('outlook.live.com'), false);
  assert.equal(isLikelyVendorHost('mail.proton.me'), false);
  assert.equal(isLikelyVendorHost('roundcube.example.org'), false);
  assert.equal(isLikelyVendorHost('webmail.example.org'), false);
  assert.equal(isLikelyVendorHost(null), false);
});

test('ordinary shopping hosts are offered', () => {
  assert.equal(isLikelyVendorHost('www.chewy.com'), true);
  assert.equal(isLikelyVendorHost('patagonia.com'), true);
  // Label boundaries again: none of these is webmail, however much the string
  // looks like it.
  assert.equal(isLikelyVendorHost('mail.google.com.evil.example'), true);
  assert.equal(isLikelyVendorHost('gmail.com.br'), true);
  assert.equal(isLikelyVendorHost('notgmail.com'), true);
  assert.equal(isLikelyVendorHost('roundcubes.example.org'), true);
});

test('a www. host is suggested as the bare domain', () => {
  // Patterns are suffix rules, so a leading www. narrows: keeping it would miss
  // checkout.chewy.com and every other sibling subdomain.
  assert.equal(suggestPattern('www.chewy.com'), 'chewy.com');
  assert.equal(suggestPattern('chewy.com'), 'chewy.com');
  assert.equal(suggestPattern('checkout.chewy.com'), 'checkout.chewy.com');
  assert.equal(suggestPattern('www2.chewy.com'), 'www2.chewy.com');
  assert.equal(suggestPattern(null), '');
});
