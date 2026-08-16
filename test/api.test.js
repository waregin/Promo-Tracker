import test from 'node:test';
import assert from 'node:assert/strict';

import { supportsDirectoryPicker, supportsFolderWrites, downloadableUrl } from '../src/lib/api.js';

/** Run `fn` with globals temporarily set, then put everything back. */
function withGlobals(values, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.prototype.hasOwnProperty.call(globalThis, key)
      ? { present: true, value: globalThis[key] }
      : { present: false });
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, entry] of saved) {
      if (entry.present) globalThis[key] = entry.value;
      else delete globalThis[key];
    }
  }
}

test('the picker and the handle are separate capabilities', () => {
  // This distinction is load-bearing. A Chromium service worker has no
  // showDirectoryPicker but can still write through a handle the page picked;
  // checking the picker in the background silently breaks folder backups.
  withGlobals({ showDirectoryPicker: undefined, FileSystemDirectoryHandle: function () {} }, () => {
    assert.equal(supportsDirectoryPicker(), false, 'a worker has no picker');
    assert.equal(supportsFolderWrites(), true, 'but it can still write');
  });
});

test('a page on Chromium has both', () => {
  withGlobals({ showDirectoryPicker: () => {}, FileSystemDirectoryHandle: function () {} }, () => {
    assert.equal(supportsDirectoryPicker(), true);
    assert.equal(supportsFolderWrites(), true);
  });
});

test('Firefox has neither, anywhere', () => {
  withGlobals({ showDirectoryPicker: undefined, FileSystemDirectoryHandle: undefined }, () => {
    assert.equal(supportsDirectoryPicker(), false);
    assert.equal(supportsFolderWrites(), false);
  });
});

test('a blob URL is used when the context can make one', () => {
  const created = [];
  withGlobals({
    URL: Object.assign(Object.create(URL), {
      createObjectURL: (blob) => { created.push(blob); return 'blob:fake-1'; },
      revokeObjectURL: () => {},
    }),
  }, () => {
    const { url } = downloadableUrl('{"a":1}');
    assert.equal(url, 'blob:fake-1');
    assert.equal(created.length, 1);
  });
});

test('a data URL is the fallback where createObjectURL is missing', () => {
  // Exactly the Chrome MV3 service worker case.
  withGlobals({
    URL: Object.assign(Object.create(URL), { createObjectURL: undefined, revokeObjectURL: undefined }),
  }, () => {
    const { url, revoke } = downloadableUrl('{"a":1}');
    assert.match(url, /^data:application\/json;base64,/);
    assert.equal(Buffer.from(url.split(',')[1], 'base64').toString('utf8'), '{"a":1}');
    assert.doesNotThrow(revoke, 'the no-op revoke must be safe to call');
  });
});
