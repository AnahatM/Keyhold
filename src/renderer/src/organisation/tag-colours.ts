// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Tag colours, resolved from a **token name** to a theme variable.
 *
 * `Tag.colour` is documented in `@shared/model/vault-document.ts` as "a token name, never a
 * raw colour". This file is the one place that turns such a name into something CSS can
 * paint, and it can only ever emit a `var(--kh-color-*)` reference — there is no code path
 * here that produces a hex, an `rgb()`, or anything a theme cannot override. A vault that
 * arrived from a merge or a hand edit with `colour: "#ff0000"` in it therefore renders in
 * the neutral token rather than punching a hardcoded colour through the theme.
 *
 * ## Why these six, and why they are borrowed
 *
 * The palette in `@shared/theme/tokens.ts` has no tag-specific family, and that file is not
 * this module's to edit. The six names below map onto tokens that already exist and already
 * pass the contrast guard in every theme. The cost is that `warning` and `danger` overlap
 * with the health dashboard's signal colours, which the token file explicitly asks to keep
 * for meaning — so a dedicated `--kh-color-tag-*` family is the right long-term answer and
 * is recorded as such rather than smuggled in here.
 *
 * ## Colour is never the information
 *
 * The swatch this drives is `aria-hidden` decoration. A tag's **name** is what identifies
 * it, everywhere, for everyone — WCAG 1.4.1. Nothing in the sidebar may become
 * distinguishable by colour alone.
 */

export const TAG_COLOUR_TOKENS = [
  'neutral',
  'accent',
  'info',
  'success',
  'warning',
  'danger',
] as const;

export type TagColourToken = (typeof TAG_COLOUR_TOKENS)[number];

/**
 * What an unknown, empty or malformed name becomes.
 *
 * Neutral rather than accent: an unrecognised value is missing information, and inventing
 * a loud colour for it would make a data problem look like a deliberate choice.
 */
export const DEFAULT_TAG_COLOUR: TagColourToken = 'neutral';

/**
 * The only mapping from a token name to something paintable.
 *
 * `Record<TagColourToken, string>` rather than a lookup with a fallback branch, so adding a
 * name to `TAG_COLOUR_TOKENS` without giving it a variable is a compile error instead of a
 * tag that renders invisible.
 */
const SWATCH_VARIABLE: Readonly<Record<TagColourToken, string>> = {
  neutral: 'var(--kh-color-text-subtle)',
  accent: 'var(--kh-color-accent)',
  info: 'var(--kh-color-info)',
  success: 'var(--kh-color-success)',
  warning: 'var(--kh-color-warning)',
  danger: 'var(--kh-color-danger)',
};

/** Human labels for the colour picker. The name is what a screen reader announces. */
const COLOUR_LABEL: Readonly<Record<TagColourToken, string>> = {
  neutral: 'Neutral',
  accent: 'Accent',
  info: 'Blue',
  success: 'Green',
  warning: 'Amber',
  danger: 'Red',
};

export function isTagColourToken(value: string): value is TagColourToken {
  return (TAG_COLOUR_TOKENS as readonly string[]).includes(value);
}

/** Any string in, a token guaranteed to resolve out. */
export function resolveTagColour(colour: string | null | undefined): TagColourToken {
  if (typeof colour !== 'string') return DEFAULT_TAG_COLOUR;
  const trimmed = colour.trim();
  return isTagColourToken(trimmed) ? trimmed : DEFAULT_TAG_COLOUR;
}

/** A `var(--kh-color-*)` reference, never a literal colour. */
export function tagSwatchColour(colour: string | null | undefined): string {
  return SWATCH_VARIABLE[resolveTagColour(colour)];
}

export function tagColourLabel(colour: string | null | undefined): string {
  return COLOUR_LABEL[resolveTagColour(colour)];
}
