/**
 * Builds `dist/promo-tracker-<version>.xpi` — the file you install in
 * LibreWolf. An .xpi is just a zip with the manifest at its root, so this is
 * also a valid Chrome zip if you ever want one.
 *
 *   npm run package
 */

import { createWriteStream, mkdirSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'dist');

/** Everything the browser needs, and nothing else. */
const INCLUDE = ['manifest.json', 'icons', 'src'];

const { version } = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const outfile = join(OUT_DIR, `promo-tracker-${version}.xpi`);

mkdirSync(OUT_DIR, { recursive: true });
rmSync(outfile, { force: true });

// Sanity check before packaging something that cannot load.
for (const entry of INCLUDE) {
  try {
    statSync(join(ROOT, entry));
  } catch {
    throw new Error(`Missing ${entry} — refusing to package an incomplete extension.`);
  }
}

execFileSync('zip', ['-r', '-q', '-X', outfile, ...INCLUDE], { cwd: ROOT });

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return n;
}

const bytes = statSync(outfile).size;
console.log(`wrote ${relative(ROOT, outfile)}  (${(bytes / 1024).toFixed(1)} KB, ${countFiles(join(ROOT, 'src')) + 5} files)`);
console.log('Install: LibreWolf → about:addons → gear → Install Add-on From File…');
console.log('If it is refused as unsigned, see "Installing" in the README.');
