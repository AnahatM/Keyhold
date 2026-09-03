// SPDX-License-Identifier: GPL-3.0-or-later
import { parseColour, type Rgb } from './contrast.js';
import { COLOUR_TOKENS, type ColourToken, type Palette } from './tokens.js';

/**
 * The **material** token vocabulary — the second half of the token layer.
 *
 * A colour theme decides *hue*. A UI style decides *material*: how thick an edge is, how
 * round a corner is, how far a surface floats off the page, how solid a fill is, and what
 * texture sits behind everything. The two are separate axes and every style has to work
 * under every theme, which is only possible if neither can reach into the other.
 *
 * ## Where the line is drawn, and why
 *
 * **A token belongs to the style if changing the colour theme should not change it, and to
 * the theme if changing the style should not.** Applied literally, that puts the answer
 * beyond argument in almost every case:
 *
 *  - A border *width* is material. Nord and Dawn should both draw a 1px edge under Flat and
 *    a 0px one under Neumorphic. → style.
 *  - A border *colour* is hue. Every style draws its edge in `--kh-color-border`, whatever
 *    that happens to be today. → theme.
 *  - A shadow is the hard case, because it is both: its *geometry* (offset, blur, spread,
 *    whether there are two of them and one is a highlight) is the single strongest signal
 *    of which style you are looking at, while its *colour* must darken a light theme and a
 *    dark theme by different amounts. It is resolved here as a style token whose colour
 *    arrives **through** `color-mix()` over a colour token — never as a literal. A style
 *    that wrote its own black would break hard rule 4, and `tools/no-hardcoded-colours.test.ts`
 *    would say so.
 *
 * The same rule decides what is deliberately **not** here:
 *
 *  - **The focus ring.** `:focus-visible` is the only way a keyboard user knows where they
 *    are, and its width and colour are an accessibility guarantee, not a look. A style that
 *    could thin it or fade it would be a style that could break the app for one group of
 *    users while looking better to everyone else. It stays in `base.css` and the palette.
 *  - **Motion.** Durations already run through `--kh-motion-scale`, which the reduced-motion
 *    setting collapses to zero. Giving a style its own easing would put a second dial on an
 *    accessibility axis that must have exactly one.
 *  - **Spacing, type scale, density, row heights.** Those are the *layout* axis, already
 *    owned by `base.css` and the density setting. A style changes what a surface is made of,
 *    not how much of the screen it takes.
 *
 * ## Naming
 *
 * Every generated custom property is `--kh-style-<token>`, mirroring `--kh-color-<token>`.
 * The two prefixes never collide, so reading a rule tells you which axis is being asked.
 *
 * ## What a value may contain
 *
 * A raw CSS value, with one restriction that is enforced by a test: **the only custom
 * properties a style token may reference are `--kh-color-*` and `--kh-style-*`.** A colour
 * has to come from the palette, so a style stays theme-agnostic; a self-reference (the
 * texture reading its own cell size) is legitimate and checked to name a real token. Reaching
 * for `--kh-space-3` is refused rather than allowed-and-unchecked, because nothing here can
 * verify that a `base.css` property still exists, and an unresolved `var()` fails silently.
 */

export const STYLE_TOKENS = [
  // ── Edges ───────────────────────────────────────────────────────────────────
  /**
   * The width of a *decorative* edge — a panel, a card, a button.
   *
   * May legitimately be `0px`: Neumorphic replaces its edges with shadow entirely. It is
   * explicitly **not** the width of an input outline or a popover outline, which carry
   * WCAG 2.2 SC 1.4.11 weight and keep their own fixed width in `base.css`. A style is
   * allowed to be quiet; it is not allowed to make a control boundary disappear.
   */
  'border-width',
  /** Row separators and section rules. Structure survives even when Minimalist drops edges. */
  'divider-width',
  /**
   * How opaque a decorative edge is, as a percentage, applied via `color-mix()`.
   *
   * Paired with `fill-opacity`, this is the border-versus-fill emphasis dial: a style that
   * wants outline over mass raises this and lowers that, and Holographic does exactly that.
   *
   * **Only ever applied to `--kh-color-border`** — see {@link FADEABLE_LINE_TOKENS}.
   */
  'border-opacity',

  // ── Corners ─────────────────────────────────────────────────────────────────
  /**
   * A unitless multiplier over the radius ladder in `base.css`, not a second ladder.
   *
   * One number rather than four tokens on purpose (hard rule 8): the ratios between
   * `sm`/`md`/`lg`/`full` are a design decision that belongs to the design system, and a
   * style that could set them independently would be able to produce a card with a rounder
   * corner than the chip inside it.
   */
  'radius-scale',

  // ── Elevation ───────────────────────────────────────────────────────────────
  // Complete `box-shadow` values, because the *shape* of the elevation is the style. A
  // strength multiplier was rejected: Neumorphic's defining feature is a second, lighter
  // shadow cast from the opposite corner, and no scalar can add one.
  'shadow-sm',
  'shadow-md',
  'shadow-lg',
  /** The pressed / recessed state. `none` for the styles that do not model depth. */
  'shadow-inset',

  // ── Material ────────────────────────────────────────────────────────────────
  /** Panel, card and row fill opacity, as a percentage. */
  'surface-opacity',
  /** Button, chip and badge fill opacity, as a percentage. */
  'fill-opacity',
  /**
   * The `backdrop-filter` blur radius. `0px` disables it.
   *
   * A length rather than a boolean so `prefers-reduced-transparency` has something to set
   * to zero without a style having to ship a second, opaque copy of itself.
   */
  'blur',

  // ── Texture ─────────────────────────────────────────────────────────────────
  /** A `background-image` for the app background. `none` for the styles with no texture. */
  'texture-image',
  /** The texture's `background-size` — the grid pitch, for the styles that draw one. */
  'texture-size',
  /**
   * How strongly the texture reads, as a percentage.
   *
   * Separate from the image so the grid can be dimmed — or removed under reduced
   * transparency — without a second copy of the gradient. The contrast guard reads this: a
   * grid line is a background that body text can land on, and at a high enough opacity it
   * is the thing that quietly breaks AA.
   */
  'texture-opacity',

  // ── Accent material ─────────────────────────────────────────────────────────
  /** A `background-image` laid over an accent fill — the gradient half of a style. */
  'accent-image',
] as const;

export type StyleToken = (typeof STYLE_TOKENS)[number];

/** A complete material set. Every token is required — a partial style will not compile. */
export type StyleTokens = Record<StyleToken, string>;

export interface StyleDefinition {
  readonly id: string;
  readonly name: string;
  /** One sentence, shown beside the style in settings. */
  readonly summary: string;
  readonly tokens: StyleTokens;
}

/**
 * The colour tokens a style's `border-opacity` may fade.
 *
 * Exactly one entry, and the omissions are the point. `border-strong` is what an input
 * outline and a popover outline are drawn in, and it is held to 3:1 by
 * `CONTRAST_REQUIREMENTS` under SC 1.4.11; `focus-ring` is the keyboard user's only
 * position indicator. Both have **zero headroom** in the shipped palettes — `border-strong`
 * on `bg` in Dawn was deliberately darkened until it cleared 3.0 by a hair — so fading
 * either by any amount at all puts a theme below AA.
 *
 * A test asserts both stay out of this list. That is the guard: the failure it prevents is
 * a future style deciding that "softer outlines" should apply to every line in the app.
 */
export const FADEABLE_LINE_TOKENS: readonly ColourToken[] = ['border'];

/**
 * Which of a style's two opacity dials governs a fill drawn in each colour token.
 *
 * The contrast guard needs this and cannot deduce it: "is `accent-subtle` a panel or a
 * chip?" is a design fact, exactly like `CONTRAST_REQUIREMENTS` is. Getting it wrong in
 * either direction is expensive — check a chip's tint at the panel opacity and a legal
 * style is rejected; check a panel at the chip opacity and an illegal one ships.
 *
 * Exhaustive over `ColourToken` on purpose rather than covering only the tokens that appear
 * as backgrounds today, so **adding a colour is a compile error here** and someone has to
 * answer the question at the moment they add it, rather than the guard quietly not covering
 * the new one.
 *
 * `opaque` is the answer for every text and line colour, and that is the load-bearing half:
 * **a style may fade a fill; it may never fade text.** Translucent body text is unreadable
 * for exactly the people who can least afford it, and no visual idea is worth it.
 */
export type FillKind = 'opaque' | 'surface' | 'fill';

export const FILL_KINDS: Record<ColourToken, FillKind> = {
  // The root. Nothing is behind it, so there is nothing for it to be translucent over.
  bg: 'opaque',

  surface: 'surface',
  'surface-raised': 'surface',
  'surface-sunken': 'surface',
  'surface-hover': 'surface',
  // The modal scrim's whole job is to be translucent, and it is drawn over the app rather
  // than over `bg`. It never sits under text, so no requirement names it as a background.
  overlay: 'opaque',

  border: 'opaque',
  'border-strong': 'opaque',
  'focus-ring': 'opaque',

  text: 'opaque',
  'text-muted': 'opaque',
  'text-subtle': 'opaque',
  'text-inverse': 'opaque',

  // A primary button is a fill, not a panel — it is the surface a style most wants to make
  // translucent, and the one where doing so most easily breaks AA.
  accent: 'fill',
  'accent-hover': 'fill',
  'accent-active': 'fill',
  'accent-on': 'opaque',
  'accent-subtle': 'fill',
  'accent-subtle-text': 'opaque',

  success: 'fill',
  'success-text': 'opaque',
  'success-subtle': 'fill',
  warning: 'fill',
  'warning-text': 'opaque',
  'warning-subtle': 'fill',
  danger: 'fill',
  'danger-text': 'opaque',
  'danger-subtle': 'fill',
  info: 'fill',
  'info-text': 'opaque',
  'info-subtle': 'fill',
};

/** Checks that an object is a complete material set, for settings restored from disk. */
export function isCompleteStyleTokens(value: unknown): value is StyleTokens {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return STYLE_TOKENS.every(
    (token) => typeof candidate[token] === 'string' && candidate[token].trim() !== ''
  );
}

// ── Reading what a style token refers to ─────────────────────────────────────

export interface TokenReferences {
  /** Bare colour-token names — `accent` for `var(--kh-color-accent)`. */
  readonly colours: readonly string[];
  /** Bare style-token names — `texture-size` for `var(--kh-style-texture-size)`. */
  readonly styles: readonly string[];
  /** Full property names of anything else referenced. Always a failure; see below. */
  readonly others: readonly string[];
}

const REFERENCE = /var\(\s*(--kh-[a-z0-9-]+)/gu;

/**
 * Splits every `var(--kh-…)` in a style token's value into the three kinds.
 *
 * `others` exists so the guard can *fail* on it rather than shrug. A style token reaching
 * for `--kh-space-3` or misspelling `--kh-colour-accent` would resolve to nothing, and an
 * unresolved `var()` with no fallback drops the whole declaration silently — the exact
 * failure mode `tools/css-tokens-resolve.test.ts` exists to catch in stylesheets, arriving
 * instead through a token defined in TypeScript that that test cannot see.
 */
export function referencesIn(value: string): TokenReferences {
  const colours: string[] = [];
  const styles: string[] = [];
  const others: string[] = [];

  for (const match of value.matchAll(REFERENCE)) {
    const name = match[1] ?? '';
    if (name.startsWith('--kh-color-')) {
      colours.push(name.slice('--kh-color-'.length));
    } else if (name.startsWith('--kh-style-')) {
      styles.push(name.slice('--kh-style-'.length));
    } else {
      others.push(name);
    }
  }

  return { colours, styles, others };
}

export function isColourToken(name: string): name is ColourToken {
  return (COLOUR_TOKENS as readonly string[]).includes(name);
}

export function isStyleToken(name: string): name is StyleToken {
  return (STYLE_TOKENS as readonly string[]).includes(name);
}

// ── The maths the contrast guard needs ───────────────────────────────────────

/**
 * `'92%'` → `0.92`. Returns `null` for anything that is not a percentage in range.
 *
 * Opacities are stored as percentage strings rather than as unitless numbers so they drop
 * straight into `color-mix(in srgb, <colour> var(--kh-style-fill-opacity), transparent)`
 * without a `calc()` wrapper at every call site.
 */
export function parseAlpha(percentage: string): number | null {
  const text = percentage.trim();
  if (!/^\d{1,3}(?:\.\d+)?%$/.test(text)) return null;
  const value = Number.parseFloat(text.slice(0, -1));
  if (value < 0 || value > 100) return null;
  return value / 100;
}

/**
 * Alpha-composites `top` over `bottom` — the "source over" operator, in sRGB.
 *
 * Chromium composites in the device space for ordinary `background-color` alpha, so this
 * matches what a user's screen will actually show. It is deliberately not gamma-correct
 * blending: being *right about the browser* matters more here than being right about optics,
 * because the number this feeds is a WCAG threshold and WCAG is defined on sRGB values.
 */
export function compositeOver(top: Rgb, bottom: Rgb, alpha: number): Rgb {
  const mix = (a: number, b: number): number => Math.round(a * alpha + b * (1 - alpha));
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b) };
}

/**
 * What a translucent fill of `token` actually looks like on screen, in a given theme.
 *
 * The backdrop is `bg` — the app background — because that is the worst case and the only
 * one that is knowable statically. A card sitting on a panel sitting on the background
 * composites toward something *closer* to the card's own colour, so a pair that clears AA
 * against `bg` clears it everywhere; a pair checked against the nearest surface instead
 * would pass here and fail in the one place that matters.
 *
 * Returns `null` if either colour fails to parse, which the caller reports rather than
 * silently treating as a pass.
 */
export function effectiveFill(
  palette: Palette,
  token: ColourToken,
  alphaPercentage: string
): Rgb | null {
  const alpha = parseAlpha(alphaPercentage);
  if (alpha === null) return null;

  const top = parseColour(palette[token]);
  const bottom = parseColour(palette.bg);
  if (top === null || bottom === null) return null;

  return compositeOver(top, bottom, alpha);
}
