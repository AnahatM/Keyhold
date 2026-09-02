// SPDX-License-Identifier: GPL-3.0-or-later
import { contrastRatio, parseColour, type Rgb } from './contrast.js';
import type { Palette } from './tokens.js';

/**
 * Derives a complete, contrast-safe accent ramp from one colour the user picked.
 *
 * The accent picker lets someone choose any colour. That is the feature — and it is also
 * the problem, because six tokens depend on it and at least three of them have contrast
 * requirements. A naive implementation ("accent = what they picked, accent-on = white")
 * produces white-on-yellow at 1.6:1 the moment anyone picks a bright colour, and the
 * theme guard cannot catch it because it runs on the built-in themes at build time, not
 * on whatever the user chooses at runtime.
 *
 * So the derivation **measures** rather than assumes:
 *
 *  - `accent` is nudged until it clears 3:1 against the theme background, so it stays
 *    usable as a border and an icon.
 *  - It is nudged further until its label clears 4.5:1.
 *  - `accent-hover` and `accent-active` continue in the same direction, so every state is
 *    at least as readable as the rest state.
 *  - `accent-subtle-text` is stepped until it clears 4.5:1 against the tint it sits on.
 *
 * Every step moves the same way, which is what makes the result always achievable — see
 * the comment in `deriveAccentRamp` for why an independently-chosen label creates an
 * unsatisfiable conflict.
 *
 * The result is that a user cannot produce an unreadable interface by choosing an
 * unfortunate colour — the worst they can do is get a slightly different shade than they
 * picked, with the reason available in the editor.
 */

// ── Small colour helpers. Kept local; a colour library is a large dependency for this. ──

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((c) => clamp255(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Rounds to whole 8-bit channels.
 *
 * Every candidate is quantised **before** its contrast is measured, because the value that
 * actually ships is the rounded one. Measuring the unrounded blend and rounding afterwards
 * accepts a candidate at exactly 4.50 and then emits a hex colour at 4.48 — under the bar,
 * with a test that passed. That is a real bug this file had, found by the guard.
 */
function quantise({ r, g, b }: Rgb): Rgb {
  return { r: clamp255(r), g: clamp255(g), b: clamp255(b) };
}

/** Linear blend. `amount` 0 returns `a`, 1 returns `b`. */
export function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = Math.max(0, Math.min(1, amount));
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/**
 * Steps `colour` toward `target` until it reaches `minimumRatio` against `against`.
 *
 * Returns the first step that clears the bar rather than going all the way, so the result
 * stays as close to what the user asked for as the requirement allows. If even the target
 * itself cannot clear it — which happens on a mid-grey background — the target is
 * returned, because that is the best available and failing loudly here would leave the UI
 * with no colour at all.
 */
function pushUntilContrast(
  colour: Rgb,
  target: Rgb,
  against: Rgb,
  minimumRatio: number,
  steps = 20
): Rgb {
  const start = quantise(colour);
  const reference = quantise(against);
  if (contrastRatio(start, reference) >= minimumRatio) return start;

  for (let step = 1; step <= steps; step += 1) {
    const candidate = quantise(mix(start, target, step / steps));
    if (contrastRatio(candidate, reference) >= minimumRatio) return candidate;
  }
  return quantise(target);
}

export interface AccentRamp {
  readonly accent: string;
  readonly 'accent-hover': string;
  readonly 'accent-active': string;
  readonly 'accent-on': string;
  readonly 'accent-subtle': string;
  readonly 'accent-subtle-text': string;
}

/**
 * Builds the six accent tokens for `accentColour` within `basePalette`'s scheme.
 *
 * Returns `null` if the colour cannot be parsed, so the editor can say "not a colour"
 * while the user is mid-type rather than rendering something broken.
 */
export function deriveAccentRamp(
  accentColour: string,
  basePalette: Palette,
  scheme: 'light' | 'dark'
): AccentRamp | null {
  const chosen = parseColour(accentColour);
  const background = parseColour(basePalette.bg);
  const surface = parseColour(basePalette.surface);
  if (chosen === null || background === null || surface === null) return null;

  // Everything below moves in ONE direction: toward white in a dark theme, toward black
  // in a light one. That single choice is what makes the derivation always satisfiable.
  //
  // The label is the opposite extreme, which means every adjustment improves BOTH
  // constraints at once — contrast against the page background AND contrast against the
  // label. Letting the label be chosen independently (whichever of black/white happens to
  // suit the user's colour) creates a genuine conflict in half the cases: the accent then
  // has to move toward the background to satisfy the label, and toward the label to stay
  // visible as a border. There is no value that satisfies both, and something has to give.
  //
  // It also matches what design systems converge on anyway — dark interfaces use bright
  // accents with dark labels, light interfaces use deep accents with white labels.
  const towardReadable = scheme === 'dark' ? WHITE : BLACK;
  const label = scheme === 'dark' ? BLACK : WHITE;

  // 1. Visible as a border and an icon (WCAG 2.2 SC 1.4.11). A pale accent on a white
  //    page is an invisible border, however pretty it looks filling a button.
  const visibleAccent = pushUntilContrast(chosen, towardReadable, background, 3);

  // 2. Readable under its own label. Same direction, so step 1 is never undone.
  const accent = pushUntilContrast(visibleAccent, towardReadable, label, 4.5);

  // 3. Hover and active continue in that direction, so every state is at least as
  //    readable as the rest state and a pressed button reads as more emphatic, not faded.
  const accentHover = mix(accent, towardReadable, 0.13);
  const accentActive = mix(accent, towardReadable, 0.24);
  const accentOn = label;

  // The tint behind selected rows and chips: the accent barely present on the surface.
  const accentSubtle = mix(surface, accent, scheme === 'dark' ? 0.18 : 0.12);
  const accentSubtleText = pushUntilContrast(accent, towardReadable, accentSubtle, 4.5);

  return {
    accent: toHex(accent),
    'accent-hover': toHex(accentHover),
    'accent-active': toHex(accentActive),
    'accent-on': toHex(accentOn),
    'accent-subtle': toHex(accentSubtle),
    'accent-subtle-text': toHex(accentSubtleText),
  };
}

/** Returns a copy of `palette` with a user-chosen accent applied. */
export function applyAccent(
  palette: Palette,
  accentColour: string | null,
  scheme: 'light' | 'dark'
): Palette {
  if (accentColour === null) return palette;
  const ramp = deriveAccentRamp(accentColour, palette, scheme);
  if (ramp === null) return palette;
  return { ...palette, ...ramp };
}

/**
 * The accent colours offered in the picker.
 *
 * A curated set rather than a colour wheel as the primary control: most people want "a
 * nice blue", not to specify a hex value. The free-form input is still there for anyone
 * who does. Every one of these is verified against every theme by `accent.test.ts`.
 */
export const ACCENT_PRESETS: readonly { id: string; name: string; colour: string }[] = [
  { id: 'default', name: 'Theme default', colour: '' },
  { id: 'blue', name: 'Blue', colour: '#3355cc' },
  { id: 'indigo', name: 'Indigo', colour: '#5b4bd6' },
  { id: 'violet', name: 'Violet', colour: '#8a3fd1' },
  { id: 'magenta', name: 'Magenta', colour: '#b0308c' },
  { id: 'rose', name: 'Rose', colour: '#b03060' },
  { id: 'red', name: 'Red', colour: '#c53030' },
  { id: 'amber', name: 'Amber', colour: '#b3760a' },
  { id: 'green', name: 'Green', colour: '#2f8a4a' },
  { id: 'teal', name: 'Teal', colour: '#12817e' },
  { id: 'cyan', name: 'Cyan', colour: '#0e7490' },
  { id: 'slate', name: 'Slate', colour: '#5a6478' },
];
