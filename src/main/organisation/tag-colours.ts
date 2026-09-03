// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Tag colours.
 *
 * The list itself moved to `@shared/model/organisation.ts`, because the renderer needs the
 * same vocabulary and briefly had a different one — see that file for what the two lists
 * disagreed about and what it would have cost. This module re-exports it so the callers in
 * `src/main/organisation/` did not all have to change, and so there is one obvious place a
 * reader lands when they go looking for it here.
 */
export {
  DEFAULT_TAG_COLOUR,
  isTagColour,
  TAG_COLOUR_TOKENS,
  type TagColour,
} from '@shared/model/organisation.js';
