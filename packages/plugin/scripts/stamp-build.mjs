/**
 * Stamp the compiled plugin bundle with a build id.
 *
 * Why this exists: `pluginVersion` is a hand-written string that stays put across
 * builds, and the command list only changes when the tool surface does. Between
 * two builds that add no tools, nothing visible distinguished the old bundle from
 * the new one — so neither the operator nor the model could answer "is Figma
 * running the build I just wrote?", and the only way to find out was to guess or
 * to re-import blindly.
 *
 * The id is a hash of the compiled source, so it changes whenever any byte of the
 * bundle changes and stays stable when nothing does (a no-op rebuild is
 * recognisable as a no-op).
 *
 *   node packages/plugin/scripts/stamp-build.mjs
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Must match the placeholder literal in src/code.ts. */
const PLACEHOLDER = '__BUILD_ID__';

const bundlePath = fileURLToPath(new URL('../dist/code.js', import.meta.url));
const source = await readFile(bundlePath, 'utf8');

const occurrences = source.split(PLACEHOLDER).length - 1;
if (occurrences === 0) {
  console.error(
    `\nno ${PLACEHOLDER} placeholder found in ${bundlePath}.\n` +
      'Either src/code.ts lost the placeholder, or this bundle was already stamped\n' +
      '(re-running tsc regenerates it, so stamping twice means the build ran twice).\n',
  );
  process.exit(1);
}
if (occurrences > 1) {
  console.error(`\n${PLACEHOLDER} appears ${occurrences} times; expected exactly one.\n`);
  process.exit(1);
}

const buildId = createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 8);
await writeFile(bundlePath, source.replace(PLACEHOLDER, buildId), 'utf8');

console.log(`plugin bundle stamped: build ${buildId}`);
