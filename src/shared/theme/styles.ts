// SPDX-License-Identifier: GPL-3.0-or-later
import type { StyleDefinition, StyleTokens } from './style-tokens.js';

/**
 * The built-in UI styles.
 *
 * Four complete material sets. A style is the *other* half of appearance: the theme decides
 * hue, the style decides what a surface is made of. Every style has to work under every
 * theme, which is why nothing below names a colour — every value that is really a colour
 * reaches one through `color-mix()` over a `--kh-color-*` token, and
 * `tools/no-hardcoded-colours.test.ts` fails the build if that slips.
 *
 * **`styles.test.ts` verifies the cross-product**, not the styles one at a time. A style is
 * eight themes' worth of appearance, and the failure this project keeps meeting is a value
 * that is fine in seven of them: Dawn's `border-strong` had to be darkened until it cleared
 * 3.0 by a hair, and a style that fades an edge by even a few percent puts it back under.
 * Per-style checking would not have seen it.
 *
 * ## On the values
 *
 * They are structural and deliberately conservative — the shapes are right, the tuning is
 * not finished. Where a number is load-bearing for a guard rather than for taste, the
 * comment says so, because the difference matters when someone comes to make Holographic
 * prettier: `fill-opacity` is not a taste dial, it is the number that decides whether white
 * text on a primary button is still legible in Solarized Light.
 */

// ── Flat — what Keyhold looks like today ──────────────────────────────────────
//
// Named and kept, so choosing a style is never a one-way door. The values reproduce the
// ladder that was hardcoded in `base.css`, with one change that is an improvement rather
// than a port: the shadow colour was a literal black at three opacities, which is the one
// colour in the app that never followed the theme. It now mixes `overlay` — the palette's
// own scrim colour, which every theme already tunes for its own depth.
const flat: StyleTokens = {
  'border-width': '1px',
  'divider-width': '1px',
  'border-opacity': '100%',

  'radius-scale': '1',

  'shadow-sm': '0 1px 2px color-mix(in srgb, var(--kh-color-overlay) 8%, transparent)',
  'shadow-md': '0 4px 12px color-mix(in srgb, var(--kh-color-overlay) 12%, transparent)',
  'shadow-lg': '0 12px 32px color-mix(in srgb, var(--kh-color-overlay) 20%, transparent)',
  'shadow-inset': 'none',

  'surface-opacity': '100%',
  'fill-opacity': '100%',
  blur: '0px',

  'texture-image': 'none',
  'texture-size': '0px',
  'texture-opacity': '0%',

  'accent-image': 'none',
};

// ── Minimalist — less chrome, more whitespace ─────────────────────────────────
//
// Edges soften, elevation goes almost entirely, corners tighten. Two things deliberately do
// not go away: `divider-width` stays at 1px, because a credential list with no row
// separators is a wall of text rather than a scannable list; and `shadow-lg` stays faint
// rather than `none`, because the skip link and other floating chrome appear over content
// with no scrim behind them and would otherwise have nothing at all to separate them.
const minimalist: StyleTokens = {
  'border-width': '1px',
  'divider-width': '1px',
  // Only ever applied to `--kh-color-border`; see FADEABLE_LINE_TOKENS. Softening the edge
  // that carries no contrast requirement is the whole trick — softening the one that does
  // would put every theme under SC 1.4.11 at once.
  'border-opacity': '55%',

  'radius-scale': '0.5',

  'shadow-sm': 'none',
  'shadow-md': 'none',
  'shadow-lg': '0 8px 24px color-mix(in srgb, var(--kh-color-overlay) 10%, transparent)',
  'shadow-inset': 'none',

  'surface-opacity': '100%',
  'fill-opacity': '100%',
  blur: '0px',

  'texture-image': 'none',
  'texture-size': '0px',
  'texture-opacity': '0%',

  'accent-image': 'none',
};

// ── Neumorphic — soft extruded surfaces, dual-light shadows ───────────────────
//
// The one style whose look is carried entirely by elevation, which is why `shadow-*` had to
// be a complete `box-shadow` value rather than a strength multiplier: a neumorphic surface
// casts *two* shadows, a dark one away from the light and a light one toward it, and no
// scalar over a single shadow can produce the second.
//
// The highlight mixes `surface-raised` rather than a white literal. It is the palette's
// "nearest the front" surface and is lighter than `surface` in every dark theme — which is
// where neumorphism reads best anyway. In Dawn and Rose, `surface-raised` and `surface` are
// both pure white, so the highlight does almost nothing and the effect is one-sided: that is
// a real limitation of extruded surfaces on a white page, not a bug to code around.
const neumorphic: StyleTokens = {
  // Edges are replaced by shadow entirely. Legitimate here precisely because this token is
  // the *decorative* edge — input and popover outlines keep their own fixed width and their
  // `border-strong` colour, so no control boundary disappears with it.
  'border-width': '0px',
  'divider-width': '1px',
  'border-opacity': '45%',

  'radius-scale': '1.6',

  'shadow-sm':
    '3px 3px 6px color-mix(in srgb, var(--kh-color-overlay) 16%, transparent), ' +
    '-3px -3px 6px color-mix(in srgb, var(--kh-color-surface-raised) 55%, transparent)',
  'shadow-md':
    '6px 6px 14px color-mix(in srgb, var(--kh-color-overlay) 22%, transparent), ' +
    '-6px -6px 14px color-mix(in srgb, var(--kh-color-surface-raised) 60%, transparent)',
  'shadow-lg':
    '12px 12px 28px color-mix(in srgb, var(--kh-color-overlay) 28%, transparent), ' +
    '-12px -12px 28px color-mix(in srgb, var(--kh-color-surface-raised) 65%, transparent)',
  'shadow-inset':
    'inset 3px 3px 7px color-mix(in srgb, var(--kh-color-overlay) 22%, transparent), ' +
    'inset -3px -3px 7px color-mix(in srgb, var(--kh-color-surface-raised) 55%, transparent)',

  'surface-opacity': '100%',
  'fill-opacity': '100%',
  blur: '0px',

  'texture-image': 'none',
  'texture-size': '0px',
  'texture-opacity': '0%',

  'accent-image': 'none',
};

// ── Holographic Blueprint — the new default ───────────────────────────────────
//
// A grid behind everything, an accent rim on raised surfaces, a gradient across accent
// fills, and enough translucency to read as glass. The two numbers to understand before
// tuning it:
//
//  - **`fill-opacity` is a contrast number, not a taste one.** It composites a primary
//    button's fill toward the page behind it, and `accent-on` still has to clear 4.5:1 on
//    the result in every theme. **91% is the floor**, measured rather than guessed, and
//    Solarized Light is the binding case — its accent is the lightest blue in the set and it
//    carries white text. A genuinely glassy button is still available and this is the way to
//    get one: put `accent`-coloured text on an `accent-subtle` fill instead of `accent-on` on
//    `accent`. Both sides then move together as the fill fades, so the headroom is enormous.
//  - **`texture-opacity` is a contrast number too, and a tighter one.** A grid line is a
//    background that text and outlines land on. **29% is the ceiling**, and the binding pair
//    is `border-strong` on `bg` in Rose and Solarized Light — an input outline, held to 3:1
//    under SC 1.4.11, which those two palettes clear with almost nothing to spare. A grid
//    strong enough to see clearly is a grid that hides the edge of a text field.
//
// The guard reads `texture-opacity` and ignores the mix percentage *inside* the gradient,
// which is deliberate and safe in the right direction: the inner mix can only ever make the
// line fainter than the token says, so the modelled grid is an upper bound on the real one
// whatever the gradient is rewritten to.
const holographic: StyleTokens = {
  'border-width': '1px',
  'divider-width': '1px',
  // Opaque on purpose. The style's signature is an outlined fill — a crisp edge around a
  // translucent body — so the border is the part that must not soften.
  'border-opacity': '100%',

  'radius-scale': '1.2',

  'shadow-sm': '0 1px 2px color-mix(in srgb, var(--kh-color-overlay) 10%, transparent)',
  // The second shadow is a hairline rim rather than a blur: a 0-radius, 0-offset spread in
  // the accent reads as an edge-lit surface, which is most of the "technical" half of the
  // look and costs nothing at paint time.
  'shadow-md':
    '0 6px 18px color-mix(in srgb, var(--kh-color-overlay) 16%, transparent), ' +
    '0 0 0 1px color-mix(in srgb, var(--kh-color-accent) 14%, transparent)',
  'shadow-lg':
    '0 18px 46px color-mix(in srgb, var(--kh-color-overlay) 26%, transparent), ' +
    '0 0 24px color-mix(in srgb, var(--kh-color-accent) 12%, transparent)',
  'shadow-inset':
    'inset 0 1px 0 color-mix(in srgb, var(--kh-color-surface-raised) 70%, transparent)',

  // Panels may go a long way — no declared pair depends on a surface staying opaque, because
  // every text colour is already required to work against `bg`, which is what a translucent
  // panel fades toward. 90% is restraint, not a limit.
  'surface-opacity': '90%',
  // 5 points above the measured floor of 91%. The margin is for the accent picker: a user's
  // own accent runs through `applyAccent`, which guarantees 4.5:1 against an *opaque* fill.
  'fill-opacity': '96%',
  blur: '14px',

  // Two repeating gradients, one per axis, drawn in the palette's own line colour. Reading
  // `--kh-style-texture-size` back means the pitch is one number rather than four, and the
  // reference is checked to name a real style token.
  'texture-image':
    'repeating-linear-gradient(to right, ' +
    'color-mix(in srgb, var(--kh-color-border) 60%, transparent) 0 1px, ' +
    'transparent 1px var(--kh-style-texture-size)), ' +
    'repeating-linear-gradient(to bottom, ' +
    'color-mix(in srgb, var(--kh-color-border) 60%, transparent) 0 1px, ' +
    'transparent 1px var(--kh-style-texture-size))',
  'texture-size': '32px',
  // 7 points under the measured ceiling of 29%. A blueprint grid is meant to be sensed
  // rather than read, so the constraint and the design agree here — which is not always how
  // this goes.
  'texture-opacity': '22%',

  // Only `accent-hover` is referenced, and that is a rule the guard enforces rather than a
  // coincidence: every colour an accent gradient reaches for has to be a colour that
  // `CONTRAST_REQUIREMENTS` already declares `accent-on` sits on, or the gradient becomes a
  // background nothing has ever checked.
  'accent-image':
    'linear-gradient(150deg, ' +
    'color-mix(in srgb, var(--kh-color-accent-hover) 70%, transparent), transparent 62%)',
};

/**
 * Flat, defined once and referenced twice.
 *
 * It is both a listed style and the fallback, and writing its name and summary out in both
 * places would be a second list of exactly the kind rule 8 exists to prevent — the theme
 * layer does restate `FALLBACK_THEME`'s metadata, and that is a wart worth not copying.
 */
const FLAT_STYLE: StyleDefinition = {
  id: 'flat',
  name: 'Flat',
  summary: 'Plain surfaces, hairline edges and restrained shadows. What Keyhold looked like first.',
  tokens: flat,
};

export const STYLES: readonly StyleDefinition[] = [
  FLAT_STYLE,
  {
    id: 'minimalist',
    name: 'Minimalist',
    summary:
      'Almost no chrome — softened edges, tight corners and elevation only where it separates.',
    tokens: minimalist,
  },
  {
    id: 'neumorphic',
    name: 'Neumorphic',
    summary: 'Soft extruded surfaces lit from one corner, with no borders and dual-light shadows.',
    tokens: neumorphic,
  },
  {
    id: 'holographic',
    name: 'Holographic Blueprint',
    summary:
      'A blueprint grid, glassy fills with crisp edges, gradient accents and a sense of depth.',
    tokens: holographic,
  },
];

/**
 * The default style, named once.
 *
 * Holographic Blueprint is the intended default (Phase 20). It is a constant rather than a
 * literal repeated at the fallback, in `toCssVariables` and in the settings panel, because
 * a default that lives in three places changes in two of them.
 */
export const DEFAULT_STYLE_ID = 'holographic';

/**
 * A style guaranteed to exist, for the last step of every fallback chain.
 *
 * Deliberately **Flat**, not the default. This is what a settings file naming a style that
 * no longer exists resolves to, and the safest possible answer to "we do not know what you
 * asked for" is the plainest surface in the set — not the one with translucency and a
 * backdrop filter. Exported as a value rather than reached for via `STYLES[0]`, for the same
 * reason `FALLBACK_THEME` is: `STYLES[0]` is `StyleDefinition | undefined` under
 * `noUncheckedIndexedAccess`, and the assertion that says otherwise is the kind that hides
 * real bugs.
 */
export const FALLBACK_STYLE: StyleDefinition = FLAT_STYLE;

export function findStyle(id: string): StyleDefinition | undefined {
  return STYLES.find((style) => style.id === id);
}

/** The style a given id resolves to, falling back rather than failing. */
export function resolveStyle(id: string): StyleDefinition {
  return findStyle(id) ?? findStyle(DEFAULT_STYLE_ID) ?? FALLBACK_STYLE;
}
