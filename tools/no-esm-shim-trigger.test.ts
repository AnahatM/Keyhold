// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { isTestFile, posixRelative, sourceFilesUnder } from './source-facts.js';

/**
 * Guard: no source text that makes electron-vite splice its CommonJS shim into the middle
 * of the main bundle.
 *
 * `electron-vite`'s `vite:esm-shim` plugin has to insert a `__filename`/`__dirname`/
 * `require` shim after the last static import of an ES-format chunk. It locates that point
 * by running `ESMStaticImportRe` over the whole rendered chunk **as text** — no parser, no
 * awareness of which bytes are code and which are inside a string. Its bare-specifier
 * branch is `import` + optional whitespace + a quote, so the perfectly ordinary dialog
 * title `'Choose a file to import'` matched: the regex started at the word `import` in the
 * prose, ran the quote-to-quote scan across the next two lines, and the shim was appended
 * right there — mid-object-literal, cutting the chunk in half.
 *
 * The failure this produces is `Unterminated string literal` from `vite:esbuild-transpile`
 * at a line number in generated output, naming a string that is not the problem and a file
 * that does not exist on disk. `npm test` cannot see it, because vitest never bundles;
 * only `npm run build` does, which is why it belongs in the gate and why this guard reads
 * source rather than output — a build failure that says what is wrong is worth more than
 * one that has to be bisected.
 *
 * A bare side-effect import (`import './x.js';`) is a genuine match and legal, so a match
 * that begins a line is allowed. Prose never begins a line with `import` followed by a
 * quote; that is what separates the two without needing a parser.
 *
 * Scope is `src/main`, `src/preload` and the `src/shared` both of them import, because
 * electron-vite registers `esmShimPlugin()` on its `main` and `preload` configs only — the
 * renderer config does not get it. That boundary is load-bearing, not a convenience: the
 * renderer holds `'Don't import'` and `'Choose a file to import'` as ordinary UI copy, and
 * bending real labels around a bundler bug that cannot reach them would be the wrong trade.
 * `src/shared` is scanned because it is bundled into main, where the plugin does run.
 *
 * Fault injection performed, twice. Restoring `title: 'Choose a file to import'` in
 * `src/main/import-service/file-picker.ts` fails this test at that file and line, and
 * `npm run build` fails with `index.js:11366:19: ERROR: Unterminated string literal`.
 * Restoring the JSDoc phrase `a whole import's folder list` in
 * `src/main/organisation/folder-ops.ts` fails this test too — the second case is caught in
 * a comment, which matters because comments survive into an unminified chunk. Reverting
 * either makes both the test and the build pass.
 * Upstream: the regex lives in `node_modules/electron-vite/dist/chunks/*.js`; if a future
 * version parses instead of pattern-matching, this guard can go.
 */

const ROOT = resolve(import.meta.dirname, '..');
const SCANNED = ['src/main', 'src/preload', 'src/shared'].map((d) => resolve(ROOT, d));

/**
 * `ESMStaticImportRe`'s bare-specifier prefix, copied from electron-vite rather than
 * approximated. Matching what upstream matches is the whole point: a looser pattern would
 * report files that build fine, and a tighter one would miss the case that broke.
 */
const SHIM_TRIGGER = /(?<=\s|^|;)import\s*["']/gmu;

describe('electron-vite ESM shim trigger', () => {
  it('appears nowhere except at the start of a line', () => {
    const offenders: string[] = [];

    for (const file of SCANNED.flatMap((directory) => sourceFilesUnder(directory))) {
      if (isTestFile(file)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const match of line.matchAll(SHIM_TRIGGER)) {
          // Indentation only: a real bare import is the first thing on its line.
          if (line.slice(0, match.index).trim() === '') continue;
          offenders.push(`${posixRelative(ROOT, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      'The word "import" directly followed by a quote makes electron-vite cut the main ' +
        'bundle in half. Reword it — "…to import\'" becomes "Import … from a file".'
    ).toEqual([]);
  });
});
