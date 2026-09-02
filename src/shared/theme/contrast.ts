// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WCAG 2.x contrast maths.
 *
 * Pure, dependency-free, and used by two consumers: the guard test that checks every
 * theme, and the custom-theme editor, which shows the user a live contrast ratio as they
 * pick colours rather than letting them build something unreadable and find out later.
 *
 * Implemented from the specification rather than pulled from a package, because it is
 * thirty lines of arithmetic and a colour library is a surprisingly large dependency to
 * add to a security tool for the sake of one formula.
 *
 * Reference: WCAG 2.2, "relative luminance" and "contrast ratio".
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Parses `#rgb`, `#rrggbb`, or `rgb(r, g, b)`.
 *
 * Returns `null` rather than throwing so the theme editor can show "not a colour" while
 * the user is mid-type, instead of the field exploding on every keystroke.
 */
export function parseColour(value: string): Rgb | null {
  const text = value.trim().toLowerCase();

  if (/^#[0-9a-f]{3}$/.test(text)) {
    // `slice` rather than capture groups: a capture is `string | undefined` to the type
    // checker even when the pattern guarantees it, and the assertions needed to say
    // otherwise are exactly the ones that hide real bugs elsewhere.
    return {
      r: Number.parseInt(text.slice(1, 2).repeat(2), 16),
      g: Number.parseInt(text.slice(2, 3).repeat(2), 16),
      b: Number.parseInt(text.slice(3, 4).repeat(2), 16),
    };
  }

  if (/^#[0-9a-f]{6}$/.test(text)) {
    return {
      r: Number.parseInt(text.slice(1, 3), 16),
      g: Number.parseInt(text.slice(3, 5), 16),
      b: Number.parseInt(text.slice(5, 7), 16),
    };
  }

  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(
    text
  );
  if (rgb !== null) {
    const [, red, green, blue] = rgb;
    if (red === undefined || green === undefined || blue === undefined) return null;

    const channels = [red, green, blue].map((c) => Number.parseInt(c, 10));
    if (channels.some((c) => c > 255)) return null;
    return { r: channels[0] ?? 0, g: channels[1] ?? 0, b: channels[2] ?? 0 };
  }

  return null;
}

/** Reverses the sRGB transfer function for one channel, per WCAG. */
function linearise(channel8Bit: number): number {
  const c = channel8Bit / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(colour: Rgb): number {
  return 0.2126 * linearise(colour.r) + 0.7152 * linearise(colour.g) + 0.0722 * linearise(colour.b);
}

/**
 * Contrast ratio between two colours: 1 (identical) to 21 (black on white).
 *
 * Order-independent by construction — the lighter colour always ends up on top of the
 * fraction — which matters because it removes a whole class of "we passed the test with
 * the arguments the other way round" mistakes.
 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const lumA = relativeLuminance(a);
  const lumB = relativeLuminance(b);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Convenience for two colour strings. Returns `null` if either fails to parse. */
export function contrastBetween(foreground: string, background: string): number | null {
  const fg = parseColour(foreground);
  const bg = parseColour(background);
  if (fg === null || bg === null) return null;
  return contrastRatio(fg, bg);
}

export type WcagLevel = 'AAA' | 'AA' | 'AA-large' | 'fail';

/**
 * Grades a ratio for normal-sized text.
 *
 * `AA-large` means it passes only for large text (18pt, or 14pt bold) and for non-text
 * UI boundaries. The theme editor shows this so a user picking a colour understands they
 * have not simply failed — they have qualified for a narrower use.
 */
export function gradeContrast(ratio: number): WcagLevel {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA-large';
  return 'fail';
}

/** Rounded to two places, for display and for readable test failures. */
export function formatRatio(ratio: number): string {
  return `${(Math.round(ratio * 100) / 100).toFixed(2)}:1`;
}
