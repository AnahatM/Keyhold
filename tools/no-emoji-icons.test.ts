// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard: no emoji is used as an icon.
 *
 * The set in `components/Icon.tsx` replaced them, and the reasons are worth restating here
 * because the pressure to reach for an emoji is highest at exactly the moment somebody is
 * adding one control in a hurry:
 *
 * 1. **An emoji is somebody else's artwork.** It is drawn by the OS font, so the same screen
 *    looks like two different applications on Windows and macOS, and like neither of them on
 *    a machine whose font lacks the glyph — `🗝` and `🗀` render as a replacement box in
 *    several common ones, which looks exactly like a bug.
 * 2. **It cannot follow the theme.** An emoji is full-colour and fixed. It does not take
 *    `currentColor`, so it cannot follow a palette, an accent or a style — the whole premise
 *    of the design system it would be sitting inside.
 * 3. **It is read aloud.** A screen reader announces "locked with key" for `🔒`, in a row
 *    whose text already said what it is.
 *
 * ## What this deliberately does not do
 *
 * It does not police **prose**. An emoji in a comment is a comment, and an emoji in a
 * sentence the user reads — a changelog entry, a piece of help text — is a word, not an icon.
 * Only lines that look like markup or like a data table are checked, which is where an icon
 * would actually be used.
 *
 * That is a judgement rather than a hard rule, so it errs toward the narrow side: this guard
 * would rather miss an emoji buried in an odd construction than fail a build over the word
 * "🎉" in a release note. `Icon.tsx` itself is exempt — it is the file that exists so nothing
 * else needs one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * Pictographic ranges only.
 *
 * Deliberately excludes the arrows and box-drawing blocks: `→` in a comment, `›` in a
 * breadcrumb and `─` in a section rule are typography, not icons, and a guard that failed on
 * them would be turned off within a week.
 */
/*
 * The variation selector is an alternative rather than a member of the class, because inside
 * one it combines with the preceding range and `no-misleading-character-class` is right to
 * refuse that — a class is a set of single code points, and U+FE0F is a modifier.
 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;

/** A line that is markup or a table entry — the two places an icon actually appears. */
const ICONISH = /(<[a-zA-Z]|=>|:\s*['"`]|\bicon\b|\bsymbol\b|>\s*$)/;

/**
 * Files that are allowed one, each with the reason.
 *
 * Kept as data with a reason per entry so an addition has to be argued for in a diff rather
 * than appearing as a silently wider pattern.
 */
const ALLOWED: readonly { readonly path: string; readonly why: string }[] = [
  {
    path: 'src/renderer/src/components/Icon.tsx',
    why: 'The replacement. Its own header quotes the glyphs it exists to remove.',
  },
];

function sourceFiles(): readonly string[] {
  return globSync('src/renderer/src/**/*.{ts,tsx}', { cwd: ROOT })
    .map((match) => join(ROOT, match))
    .sort();
}

describe('the icon rule', () => {
  it('no renderer file uses an emoji where an icon belongs', () => {
    const allowed = new Set(ALLOWED.map((entry) => entry.path));
    const violations: string[] = [];

    for (const file of sourceFiles()) {
      const where = relative(ROOT, file).split(sep).join('/');
      if (allowed.has(where)) continue;

      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        const trimmed = line.trim();
        // A comment is prose. So is a line with no markup and no table shape on it.
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          continue;
        }
        if (!EMOJI.test(line) || !ICONISH.test(line)) continue;

        violations.push(`${where}:${String(index + 1)}  ${trimmed.slice(0, 80)}`);
      }
    }

    expect(
      violations,
      'use <Icon name="…" /> — an emoji is drawn by the OS font, ignores the theme, and is read aloud'
    ).toEqual([]);
  });

  it('every allow-list entry still points at a file that exists', () => {
    // The failure this catches is an allow-list outliving its reason: a file is renamed, the
    // entry stays, and the exemption silently covers nothing while looking like it covers
    // something.
    for (const entry of ALLOWED) {
      expect(sourceFiles().map((file) => relative(ROOT, file).split(sep).join('/'))).toContain(
        entry.path
      );
    }
  });
});
