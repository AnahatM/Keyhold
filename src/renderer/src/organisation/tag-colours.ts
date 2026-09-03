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
 * ## Where the list comes from, and why not from here
 *
 * `@shared/model/organisation.ts`. This file briefly declared its own, offering `success`,
 * `warning` and `danger` — the health dashboard's signal colours — with a comment
 * acknowledging the overlap as a known cost. It was worse than a cost: the main process's
 * validator did not accept those names, so four of the six would have been rejected at the
 * boundary the moment the IPC channel existed, and a user picking "Red" would have got an
 * error rather than a red tag.
 *
 * The shared list excludes them on the original grounds, which were right: a decorative tag
 * wearing the same red as "this password is reused" is how a real warning stops reading as
 * one. A dedicated `--kh-color-tag-*` family is still the way to widen the palette.
 *
 * ## Colour is never the information
 *
 * The swatch this drives is `aria-hidden` decoration. A tag's **name** is what identifies
 * it, everywhere, for everyone — WCAG 1.4.1. Nothing in the sidebar may become
 * distinguishable by colour alone.
 */

import {
  DEFAULT_TAG_COLOUR,
  TAG_COLOUR_TOKENS,
  type TagColour,
} from '@shared/model/organisation.js';

export { DEFAULT_TAG_COLOUR, TAG_COLOUR_TOKENS };
/** The renderer's historical name for the same thing, kept so its callers do not all move. */
export type TagColourToken = TagColour;

/**
 * The only mapping from a token name to something paintable.
 *
 * `Record<TagColour, string>` rather than a lookup with a fallback, so adding a name to
 * `TAG_COLOUR_TOKENS` without giving it a variable is a compile error instead of a tag that
 * renders invisible.
 */
const SWATCH_VARIABLE: Readonly<Record<TagColour, string>> = {
  'text-muted': 'var(--kh-color-text-muted)',
  'text-subtle': 'var(--kh-color-text-subtle)',
  'border-strong': 'var(--kh-color-border-strong)',
  info: 'var(--kh-color-info)',
  accent: 'var(--kh-color-accent)',
};

/** Human labels for the colour picker. The name is what a screen reader announces. */
const COLOUR_LABEL: Readonly<Record<TagColour, string>> = {
  'text-muted': 'Neutral',
  'text-subtle': 'Quiet',
  'border-strong': 'Slate',
  info: 'Blue',
  accent: 'Accent',
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
