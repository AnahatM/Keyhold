// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard: path aliases must be identical in electron.vite.config.ts and in every
 * tsconfig that resolves them.
 *
 * This is a real failure mode, not a hypothetical one — the global CLAUDE.md calls
 * it out by name. When the two lists drift, the build resolves an import that the
 * type-checker cannot find (or vice versa), and the error message points nowhere
 * near the actual cause. Cheaper to assert than to debug.
 */

const ROOT = resolve(import.meta.dirname, '..');

/** Alias keys as written in electron.vite.config.ts, e.g. `@shared`. */
function viteAliasKeys(): string[] {
  const source = readFileSync(resolve(ROOT, 'electron.vite.config.ts'), 'utf8');
  const block = /const alias = \{([\s\S]*?)\n\};/.exec(source);
  expect(block, 'could not find the `const alias = { ... }` block').not.toBeNull();

  return [...(block?.[1] ?? '').matchAll(/'(@[\w-]+)':/g)].map((match) => match[1]!).sort();
}

/** Alias keys from a tsconfig `paths` map, normalised from `@shared/*` to `@shared`. */
function tsconfigAliasKeys(file: string): string[] {
  const raw = readFileSync(resolve(ROOT, file), 'utf8');
  const paths = /"paths": \{([\s\S]*?)\n {4}\}/.exec(raw);
  expect(paths, `could not find a "paths" map in ${file}`).not.toBeNull();

  return [...(paths?.[1] ?? '').matchAll(/"(@[\w-]+)\/\*":/g)].map((match) => match[1]!).sort();
}

describe('path alias parity', () => {
  const vite = viteAliasKeys();

  it('defines at least the four expected aliases', () => {
    expect(vite).toEqual(['@main', '@preload', '@renderer', '@shared']);
  });

  it.each(['tsconfig.node.json', 'tsconfig.web.json'])(
    'electron.vite.config.ts and %s declare the same aliases',
    (file) => {
      expect(tsconfigAliasKeys(file)).toEqual(vite);
    }
  );
});
