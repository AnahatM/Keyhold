// SPDX-License-Identifier: GPL-3.0-or-later
import type { ColourToken } from '../theme/tokens.js';

/**
 * The vocabulary both halves of the app use for folders and tags.
 *
 * It lives here because it was, briefly, in two places — and the two disagreed in ways that
 * would have reached a user. `src/main/organisation/` and `src/renderer/src/organisation/`
 * each declared their own `TAG_COLOUR_TOKENS` and their own folder-delete policies, and:
 *
 *  - the colour lists shared only two members, so four of the colours the sidebar offered
 *    would have been **rejected by the validator** the moment the IPC channel existed; and
 *  - the policy names differed (`unfile` against `unfile-records`) *and* so did their
 *    meaning — one deletes the whole subtree, the other claimed to keep it. A user clicking
 *    what the dialog called "move the records out" would have lost every subfolder.
 *
 * Neither was a careless copy; both files argued their case well. That is exactly why the
 * rule is "no second list" rather than "be careful with second lists": two well-reasoned
 * lists still disagree.
 */

/**
 * What a folder deletion does with everything inside it. **The caller must choose** — there
 * is no default, because both answers are reasonable and picking one silently is how records
 * end up rearranged in a way that reads as a UI glitch rather than as data movement.
 *
 *  - `reparent` — the folder alone goes. Its child folders and its records rise to where it
 *    was, and nothing else moves. This is "delete this folder, keep its contents".
 *  - `unfile` — the folder **and its whole subtree** go, and every record anywhere beneath
 *    ends up in no folder. This is "delete this branch". The records survive: they are still
 *    in the vault, still in search, and findable with `is:unfiled`.
 *
 * Neither deletes a record. A record leaves only through the trash, with a tombstone and an
 * undo — folder deletion is not a route around that.
 */
export const FOLDER_DELETE_POLICIES = ['reparent', 'unfile'] as const;
export type FolderDeletePolicy = (typeof FOLDER_DELETE_POLICIES)[number];

/**
 * The colours a tag may wear.
 *
 * A **subset of** `ColourToken`, not a parallel list, so a token renamed in `tokens.ts` is a
 * compile error here rather than a tag that renders as nothing.
 *
 * Deliberately quiet, and deliberately excluding `success`, `warning` and `danger`: those
 * three carry meaning in the health dashboard, and a decorative tag wearing the same red as
 * "this password is reused" is how a real warning stops reading as a warning. Three
 * neutrals, the informational hue, and the user's own accent for the one or two tags they
 * want to stand out.
 *
 * The palette is thin because the theme has no tag ramp. Adding `tag-1 … tag-n` to
 * `COLOUR_TOKENS`, each with a contrast requirement, is the way to widen it — and the
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

export function isFolderDeletePolicy(value: unknown): value is FolderDeletePolicy {
  return typeof value === 'string' && (FOLDER_DELETE_POLICIES as readonly string[]).includes(value);
}
