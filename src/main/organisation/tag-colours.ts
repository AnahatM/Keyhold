// SPDX-License-Identifier: GPL-3.0-or-later
import type { ColourToken } from '@shared/theme/tokens.js';

/**
 * The colours a tag may be given.
 *
 * `Tag.colour` is a **token name, never a raw colour** — that is the model's own comment on
 * the field, and hard rule 4 behind it. A hex value stored on a tag would be a colour that
 * no theme owns: unreadable in half of the eight themes, invisible in High-Contrast, and
 * outside the reach of both guard tests. So the field is validated against the theme
 * vocabulary rather than accepting any string, and `isTagColour` is the only door in.
 *
 * ## Why this is a subset, and not simply `ColourToken`
 *
 * Two thirds of the vocabulary would be wrong here, in two different ways:
 *
 *  - **Surfaces and lines** (`bg`, `surface`, `border`, `overlay`) render a chip that is the
 *    same colour as the thing behind it. A tag the user cannot see is not a choice worth
 *    offering.
 *  - **Status tokens** (`success`, `warning`, `danger`) carry meaning. `tokens.ts` says so
 *    at the point it declares them: they are the health dashboard's signal for weak,
 *    expiring and breached. A vault where tags are also red and green is a vault where the
 *    real warnings stop reading as warnings — the global guidance about keeping decorative
 *    labels calm, applied where it actually costs something.
 *
 * What is left is deliberately quiet: three neutrals, the informational hue, and the user's
 * own accent for the one or two tags they want to stand out. This is a **subset of**
 * `ColourToken`, not a parallel list — `satisfies` makes a token renamed in `tokens.ts` a
 * compile error here rather than a tag that renders as nothing (hard rule 8).
 *
 * The palette is thin because the theme has no tag ramp yet. Adding `tag-1 … tag-n` tokens
 * to `COLOUR_TOKENS`, each with a contrast requirement, is the way to widen it — and the
 * contrast guard would then cover every one of them in every theme, for free.
 */
export const TAG_COLOUR_TOKENS = [
  'text-muted',
  'text-subtle',
  'border-strong',
  'info',
  'accent',
] as const satisfies readonly ColourToken[];

export type TagColour = (typeof TAG_COLOUR_TOKENS)[number];

/**
 * A tag with no colour chosen reads as neutral secondary text.
 *
 * Not the accent: the accent is the selection colour, and a brand-new tag wearing it would
 * look like it was already selected.
 */
export const DEFAULT_TAG_COLOUR: TagColour = 'text-muted';

export function isTagColour(value: unknown): value is TagColour {
  return typeof value === 'string' && (TAG_COLOUR_TOKENS as readonly string[]).includes(value);
}
