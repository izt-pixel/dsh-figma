/**
 * Guard the one invariant Figma cannot forgive.
 *
 * Figma loads `main` as a classic script: no module loader, no bare specifier
 * resolution. If a runtime `import`, `export`, or `require` ever survives into
 * `dist/code.js` — because someone added a value import instead of a type-only
 * one, or a dependency crept into the plugin's runtime path — the plugin breaks
 * with an opaque syntax error inside Figma. Catching it here turns that into a
 * failed build with a precise message.
 */

import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const bundlePath = fileURLToPath(new URL('../dist/code.js', import.meta.url));
const uiPath = fileURLToPath(new URL('../ui.html', import.meta.url));

const source = await readFile(bundlePath, 'utf8');

const FORBIDDEN = [
  [/^\s*import\s[\s\S]*?from\s/m, 'a runtime `import ... from` statement'],
  [/^\s*import\s*["']/m, 'a side-effect `import "..."` statement'],
  [/^\s*export\s/m, 'an `export` statement'],
  [/\brequire\s*\(\s*["']/, 'a `require("...")` call'],
  [/\bmodule\.exports\b/, 'a `module.exports` assignment'],
];

const offenders = FORBIDDEN.filter(([pattern]) => pattern.test(source)).map(([, label]) => label);

if (offenders.length > 0) {
  console.error(
    `\nplugin bundle is not a plain script: ${bundlePath}\n` +
      offenders.map((label) => `  - contains ${label}`).join('\n') +
      '\n\nFigma cannot resolve modules. Import shared code with `import type` only,\n' +
      'and keep every runtime value the plugin needs inside src/code.ts.\n',
  );
  process.exit(1);
}

if (!/\b__html__\b/.test(source)) {
  console.error(
    `\nplugin bundle never references __html__: ${bundlePath}\n` +
      'The manifest declares a `ui` file, so the main thread must call figma.showUI(__html__, ...).\n',
  );
  process.exit(1);
}

await access(uiPath).catch(() => {
  console.error(`\nmanifest declares "ui": "ui.html" but ${uiPath} does not exist.\n`);
  process.exit(1);
});

const bytes = Buffer.byteLength(source);
console.log(`plugin bundle verified: dist/code.js is a ${bytes}-byte plain script, ui.html present.`);
