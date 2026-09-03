// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STYLE_TOKENS } from '../src/shared/theme/style-tokens.js';
import { COLOUR_TOKENS } from '../src/shared/theme/tokens.js';

/**
 * Guard: every `var(--kh-…)` a stylesheet reads is a custom property something declares.
 *
 * ## The gap this closes
 *
 * CLAUDE.md's rule 4 is enforced by two tests — every token resolves in every theme, and
 * every foreground/background pair passes WCAG AA. Both operate on the **token table**.
 * Neither looks at the stylesheets that consume it, so a rule referring to a property that
 * does not exist passed everything:
 *
 * ```css
 * .kh-thing { color: var(--kh-color-accent-text); }   ·  there is no `accent-text`
 * ```
 *
 * CSS custom properties fail silently by design. An unresolved `var()` with no fallback
 * makes the declaration invalid at computed-value time, so the property lands on its
 * inherited or initial value — usually black text, or a transparent background — and the
 * page still renders. Nothing throws, nothing logs, and the only signal is a screen that
 * looks slightly wrong in one theme. That is precisely the class of defect the token rule
 * exists to prevent, arriving through the door the token rule was not watching.
 *
 * ## What counts as a declaration
 *
 * Two sources, because tokens come from two places:
 *
 *  - **Style** properties are generated the same way, one per entry in `STYLE_TOKENS`, as
 *    `--kh-style-<token>`. Same reasoning, second layer.
 *  - **Colour** properties are generated, one per entry in `COLOUR_TOKENS`, as
 *    `--kh-color-<token>`. Read from that list rather than from the CSS, so a colour renamed
 *    in the token layer is caught here and not only wherever it happened to be used. It is
 *    the right authority to read: every theme is type-forced to supply every entry, so the
 *    list is exactly the set of colour properties that will exist at runtime.
 *  - **Everything else** — spacing, radii, type scale, control metrics, durations — is
 *    declared literally in the stylesheets. Collected by scanning for declarations, which
 *    also means a component stylesheet may define its own local property and use it.
 *  - **Properties set from TypeScript**, which are declarations too even though no
 *    stylesheet contains them: `appearance.ts` writes the whole appearance layer into
 *    `toCssVariables`, and `AppShell.tsx` puts the live pane widths on an inline style so a
 *    drag can move them without a re-render. Collected by scanning source for `--kh-…`
 *    string literals. Deliberately loose — this half only ever *adds* known names, so being
 *    generous costs a missed typo in a rare place, while being strict would fail the build
 *    on two properties that work perfectly.
 *
 * ## Deliberately not checked
 *
 * That a declared token is *used*. An unused token is a slightly larger stylesheet; an
 * undeclared one is a visual bug. Only one of those is worth failing a build over, and a
 * "no unused tokens" rule would fight every scale that ships a full range on purpose.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** `var(--kh-foo)` and `var(--kh-foo, fallback)` alike — the name is what matters. */
const REFERENCE = /var\(\s*(--kh-[a-z0-9-]+)/gu;

/** A declaration: the property at the start of a line, before its colon. */
const DECLARATION = /^\s*(--kh-[a-z0-9-]+)\s*:/gmu;

/** A property named in TypeScript, as `'--kh-thing'` or `"--kh-thing"`. */
const IN_SOURCE = /['"](--kh-[a-z0-9-]+)['"]/gu;

function stylesheets(): readonly string[] {
  return globSync('src/**/*.css', { cwd: ROOT })
    .map((match) => join(ROOT, match))
    .sort();
}

function sources(): readonly string[] {
  return globSync('src/**/*.{ts,tsx}', { cwd: ROOT })
    .map((match) => join(ROOT, match))
    .sort();
}

function matchesIn(source: string, pattern: RegExp): readonly string[] {
  return [...source.matchAll(pattern)].map((match) => match[1] ?? '');
}

/** Every custom property anything declares — generated colours plus literal declarations. */
function declared(files: readonly string[]): ReadonlySet<string> {
  const names = new Set<string>();

  for (const token of COLOUR_TOKENS) names.add(`--kh-color-${token}`);
  // The second generated layer, and it has to be read the same way. `appearance.ts` builds
  // these names in a template literal, so the source scan below cannot see them — without
  // this, every `var(--kh-style-…)` in a stylesheet would look undeclared.
  for (const token of STYLE_TOKENS) names.add(`--kh-style-${token}`);

  for (const file of files) {
    for (const name of matchesIn(readFileSync(file, 'utf8'), DECLARATION)) names.add(name);
  }

  for (const file of sources()) {
    for (const name of matchesIn(readFileSync(file, 'utf8'), IN_SOURCE)) names.add(name);
  }

  return names;
}

describe('CSS custom properties', () => {
  it('every var(--kh-…) a stylesheet reads is declared somewhere', () => {
    const files = stylesheets();
    expect(files.length, 'no stylesheets found — the glob is wrong').toBeGreaterThan(0);

    const known = declared(files);
    const unresolved: string[] = [];

    for (const file of files) {
      const where = relative(ROOT, file).split(sep).join('/');
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        for (const name of matchesIn(line, REFERENCE)) {
          if (!known.has(name)) unresolved.push(`${where}:${String(index + 1)} → ${name}`);
        }
      }
    }

    expect(
      unresolved,
      'these resolve to nothing at all: an unresolved var() with no fallback silently drops the declaration'
    ).toEqual([]);
  });

  it('reads the token layer as the source of colour names, not a copy of it', () => {
    // Keeps the check above honest. Swap `COLOUR_TOKENS` for a hand-written list and the
    // guard would go on passing while describing a palette that no longer exists — the
    // second-list failure, arriving inside the test meant to prevent it.
    const known = declared(stylesheets());

    expect(COLOUR_TOKENS.length, 'COLOUR_TOKENS is empty').toBeGreaterThan(0);
    for (const token of COLOUR_TOKENS) {
      expect(
        known.has(`--kh-color-${token}`),
        `--kh-color-${token} is not derived from COLOUR_TOKENS`
      ).toBe(true);
    }

    expect(STYLE_TOKENS.length, 'STYLE_TOKENS is empty').toBeGreaterThan(0);
    for (const token of STYLE_TOKENS) {
      expect(
        known.has(`--kh-style-${token}`),
        `--kh-style-${token} is not derived from STYLE_TOKENS`
      ).toBe(true);
    }
  });
});
