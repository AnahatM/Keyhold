// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { contrastBetween, formatRatio, gradeContrast, parseColour } from './contrast.js';
import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, findTheme, THEMES } from './themes.js';
import { COLOUR_TOKENS, CONTRAST_REQUIREMENTS } from './tokens.js';

/**
 * The theme guards.
 *
 * Two properties, both of which fail silently in production if unchecked:
 *
 *  1. **Every token resolves in every theme.** A missing token renders as an invisible
 *     element — text the same colour as its background, or a panel with no fill. Nobody
 *     notices until a user reports a blank screen in one theme.
 *
 *  2. **Every declared pair meets WCAG AA in every theme.** Contrast is impossible to
 *     eyeball reliably, and the failure mode is not "looks a bit washed out" but "a user
 *     with low vision cannot read their own password".
 *
 * These are not aspirational. Several values in `themes.ts` are darker or lighter than
 * they would look best at, specifically because this test rejected the prettier version.
 */

describe('theme completeness', () => {
  it('ships the eight documented themes with unique ids', () => {
    expect(THEMES).toHaveLength(8);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(8);
  });

  it('gives every theme a name, a description and a colour scheme', () => {
    for (const theme of THEMES) {
      expect(theme.name.length, `${theme.id} needs a name`).toBeGreaterThan(0);
      expect(theme.description.length, `${theme.id} needs a description`).toBeGreaterThan(10);
      expect(['light', 'dark']).toContain(theme.scheme);
    }
  });

  it.each(THEMES.map((t) => [t.id, t] as const))('%s defines every colour token', (_id, theme) => {
    for (const token of COLOUR_TOKENS) {
      const value = theme.palette[token];
      expect(value, `${theme.id} is missing "${token}"`).toBeDefined();
      expect(value.trim().length, `${theme.id}.${token} is empty`).toBeGreaterThan(0);
    }
  });

  it.each(THEMES.map((t) => [t.id, t] as const))(
    '%s defines every colour in a parseable format',
    (_id, theme) => {
      for (const token of COLOUR_TOKENS) {
        const parsed = parseColour(theme.palette[token]);
        expect(
          parsed,
          `${theme.id}.${token} = "${theme.palette[token]}" is not a colour`
        ).not.toBeNull();
      }
    }
  );

  it('defines no token that no theme uses, and no theme key that is not a token', () => {
    // Catches drift in both directions: a token removed from the vocabulary but left in a
    // palette, and a typo'd key that silently does nothing.
    const tokens = new Set<string>(COLOUR_TOKENS);
    for (const theme of THEMES) {
      for (const key of Object.keys(theme.palette)) {
        expect(tokens.has(key), `${theme.id} has an unknown token "${key}"`).toBe(true);
      }
      expect(Object.keys(theme.palette)).toHaveLength(COLOUR_TOKENS.length);
    }
  });

  it('points its default light and dark ids at themes that exist and match their scheme', () => {
    expect(findTheme(DEFAULT_LIGHT_THEME_ID)?.scheme).toBe('light');
    expect(findTheme(DEFAULT_DARK_THEME_ID)?.scheme).toBe('dark');
  });

  it('offers at least one theme of each scheme, so following the OS always resolves', () => {
    expect(THEMES.some((t) => t.scheme === 'light')).toBe(true);
    expect(THEMES.some((t) => t.scheme === 'dark')).toBe(true);
  });
});

describe('WCAG AA contrast, in every theme', () => {
  const cases = THEMES.flatMap((theme) =>
    CONTRAST_REQUIREMENTS.map((requirement) => ({ theme, requirement }))
  );

  it.each(
    cases.map(({ theme, requirement }) => [
      `${theme.id}: ${requirement.foreground} on ${requirement.background} (${requirement.note})`,
      theme,
      requirement,
    ])
  )('%s', (_label, theme, requirement) => {
    const foreground = theme.palette[requirement.foreground];
    const background = theme.palette[requirement.background];
    const ratio = contrastBetween(foreground, background);

    expect(ratio, `could not parse ${foreground} or ${background}`).not.toBeNull();
    expect(
      ratio!,
      `${theme.id} — ${requirement.foreground} (${foreground}) on ${requirement.background} ` +
        `(${background}) is ${formatRatio(ratio!)}, needs ${requirement.minimum}:1. ` +
        `Use: ${requirement.note}.`
    ).toBeGreaterThanOrEqual(requirement.minimum);
  });
});

describe('contrast maths', () => {
  it('gives black on white the canonical 21:1', () => {
    expect(contrastBetween('#000000', '#ffffff')).toBeCloseTo(21, 2);
  });

  it('gives an identical pair exactly 1:1', () => {
    expect(contrastBetween('#3355cc', '#3355cc')).toBeCloseTo(1, 5);
  });

  it('is order-independent, which removes a whole class of argument-order mistakes', () => {
    const forward = contrastBetween('#1b1c22', '#f7f7f9');
    const backward = contrastBetween('#f7f7f9', '#1b1c22');
    expect(forward).toBeCloseTo(backward!, 10);
  });

  it('parses every format a theme or the editor may produce', () => {
    expect(parseColour('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColour('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColour('rgb(18, 19, 26)')).toEqual({ r: 18, g: 19, b: 26 });
    expect(parseColour('rgba(18, 19, 26, 0.5)')).toEqual({ r: 18, g: 19, b: 26 });
    expect(parseColour('  #12131A  ')).toEqual({ r: 18, g: 19, b: 26 });
  });

  it('returns null rather than throwing for input the user is still typing', () => {
    for (const value of ['', '#', '#12', '#12345', 'rebeccapurple', 'rgb(300, 0, 0)', 'nonsense']) {
      expect(parseColour(value), `"${value}" should not parse`).toBeNull();
    }
  });

  it('grades ratios at the WCAG boundaries, not near them', () => {
    expect(gradeContrast(21)).toBe('AAA');
    expect(gradeContrast(7)).toBe('AAA');
    expect(gradeContrast(6.99)).toBe('AA');
    expect(gradeContrast(4.5)).toBe('AA');
    expect(gradeContrast(4.49)).toBe('AA-large');
    expect(gradeContrast(3)).toBe('AA-large');
    expect(gradeContrast(2.99)).toBe('fail');
    expect(gradeContrast(1)).toBe('fail');
  });

  it('formats a ratio readably for the theme editor', () => {
    expect(formatRatio(4.5)).toBe('4.50:1');
    expect(formatRatio(21)).toBe('21.00:1');
  });
});
