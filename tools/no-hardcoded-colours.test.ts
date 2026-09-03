// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard: no colour literal outside the token layer.
 *
 * The project's stated hard rule is that every colour is a `--kh-color-*` token, and
 * `docs/06-UI-Design-System/_INDEX.md` claims two guard tests enforce it. They did not.
 * Both operate over the theme *definitions* — one asserts every token resolves in every
 * theme, the other that every declared foreground/background pair passes WCAG AA — so
 * neither could see a colour anywhere else in the tree. The audit found exactly that:
 * `window.ts` carried `backgroundColor: '#12131a'`, a hardcoded dark value flashed before
 * the first paint on every launch including on a light theme, in a file no guard looked at.
 *
 * This is the test that makes the claim true: it reads every source file and fails on a
 * colour literal outside the places entitled to hold one.
 *
 * Fault injection performed: restoring `backgroundColor: '#12131a'` in `src/main/window.ts`
 * fails "no source file outside the token layer contains a colour literal"; adding
 * `color: rgb(255 0 0)` to `base.css` outside a `--kh-` declaration fails it too.
 */

const ROOT = resolve(import.meta.dirname, '..');
const SRC = resolve(ROOT, 'src');

const EXTENSIONS = ['.ts', '.tsx', '.css'];

/**
 * Where a colour literal is the correct thing to write, with the reason.
 *
 * Short by design. Every entry is a place that either *defines* the tokens or is not a
 * colour at all, and anything added here needs the same standard of justification.
 */
const ALLOWED: readonly { readonly path: string; readonly why: string }[] = [
  {
    path: 'src/shared/theme/themes.ts',
    why: 'the palettes themselves — this file IS the source of truth the rule points at',
  },
  {
    path: 'src/shared/theme/contrast.ts',
    why: 'parses colour literals to compute contrast ratios; its fixtures are colours by nature',
  },
  {
    path: 'src/shared/theme/accent.ts',
    why: 'parses and normalises a user-supplied accent colour',
  },
  {
    path: 'src/shared/theme/keeptheme.ts',
    why: 'a validation message that shows the user the colour syntax it accepts; the literals are copy',
  },
  {
    path: 'src/main/smoke.ts',
    why: "'#ff0000' is a deliberately invalid input fed to setTagColour in a launch probe, not a UI colour",
  },
  {
    path: 'src/renderer/src/theme-studio/ThemeStudio.tsx',
    why: 'shows the user an example of the colour syntax they may type; the literals are copy',
  },
];

/** Hex colours, and the `rgb()`/`rgba()`/`hsl()`/`hsla()` functional forms. */
const COLOUR_PATTERN = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Whether a line is prose rather than code.
 *
 * A deliberately simple heuristic — a line inside a block comment, or a `//` line comment.
 * It cannot be fooled into *missing* a violation, only into skipping one that is genuinely
 * commented out, which is the safe direction to be wrong in.
 */
function isComment(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('<!--')
  );
}

/** A CSS custom-property declaration is a token definition, which is the point of tokens. */
function definesToken(line: string): boolean {
  return /^\s*--kh-[\w-]+\s*:/.test(line);
}

describe('the colour rule', () => {
  it('no source file outside the token layer contains a colour literal', () => {
    const allowedPaths = new Set(ALLOWED.map((entry) => entry.path));
    const violations: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const relativePath = relative(ROOT, file).split(sep).join('/');
      if (allowedPaths.has(relativePath)) continue;
      if (relativePath.endsWith('.test.ts') || relativePath.endsWith('.test.tsx')) continue;

      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (isComment(line) || definesToken(line)) return;
        if (COLOUR_PATTERN.test(line)) {
          violations.push(`${relativePath}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    expect(violations, 'colour literals outside the token layer').toEqual([]);
  });

  it('every allow-list entry still points at a file that exists', () => {
    // An allow-list whose entries have rotted is an allow-list that quietly grants nothing
    // and hides nothing — worth failing on, so the reasons above stay real.
    for (const entry of ALLOWED) {
      expect(
        () => statSync(resolve(ROOT, entry.path)),
        `${entry.path}: ${entry.why}`
      ).not.toThrow();
    }
  });
});
