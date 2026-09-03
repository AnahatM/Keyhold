// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The refusals the folder and tag operations raise.
 *
 * Deliberately **not** `VaultError`. Every code in that enum means "this file is damaged,
 * hostile, or from the future", and its messages say so out loud. Telling someone their
 * vault is corrupt because they dragged a folder onto its own child would be a lie, and an
 * alarming one on the one screen where alarm is expensive.
 *
 * These are refusals of a request the user just made. They are phrased in the second
 * person, they say what was refused and why, and every one of them is **thrown rather than
 * swallowed** — a drag that appears to do nothing is a bug report nobody can write.
 *
 * The rule from `crypto/errors.ts` still holds: **a message never contains secret
 * material**. These messages carry no field values at all, and no folder or tag name
 * either — the caller passed the name in, so it already knows it, and interpolating user
 * content into an error that ends up in a screenshot buys nothing.
 */

export type OrganisationErrorCode =
  /** The folder id does not name a folder in this document. */
  | 'NO_SUCH_FOLDER'
  /** The tag id does not name a tag in this document. */
  | 'NO_SUCH_TAG'
  /** The move would put a folder inside itself or inside one of its own descendants. */
  | 'FOLDER_CYCLE'
  /** The result would nest deeper than `MAX_FOLDER_DEPTH`. */
  | 'FOLDER_TOO_DEEP'
  /** The document already holds `MAX_FOLDERS`. */
  | 'TOO_MANY_FOLDERS'
  /** The document already holds `MAX_TAGS`. */
  | 'TOO_MANY_TAGS'
  /** Empty after trimming, over the length cap, or carrying a character the format reserves. */
  | 'INVALID_NAME'
  /** A rename that would collide with another tag. Merging is a separate, explicit operation. */
  | 'DUPLICATE_TAG_NAME'
  /** `Tag.colour` must be one of `TAG_COLOUR_TOKENS`, never a raw colour. */
  | 'INVALID_TAG_COLOUR'
  /** Merging a tag into itself — almost certainly a UI wiring bug, never a user intent. */
  | 'MERGE_INTO_SELF'
  /** The saved-search id does not name one in this document. */
  | 'NO_SUCH_SAVED_SEARCH'
  /** The document already holds `SAVED_SEARCH_MAX`. */
  | 'TOO_MANY_SAVED_SEARCHES'
  /** Two rows with the same name are two rows the user cannot tell apart. */
  | 'DUPLICATE_SEARCH_NAME'
  /** Empty name, empty query, or either one over its cap. */
  | 'INVALID_SAVED_SEARCH';

export class OrganisationError extends Error {
  readonly code: OrganisationErrorCode;

  constructor(code: OrganisationErrorCode, message: string) {
    super(message);
    this.name = 'OrganisationError';
    this.code = code;
  }
}

export function noSuchFolder(): OrganisationError {
  return new OrganisationError('NO_SUCH_FOLDER', 'That folder no longer exists in this vault.');
}

export function noSuchTag(): OrganisationError {
  return new OrganisationError('NO_SUCH_TAG', 'That tag no longer exists in this vault.');
}

export function folderCycle(): OrganisationError {
  return new OrganisationError(
    'FOLDER_CYCLE',
    'A folder cannot be moved into itself or into one of the folders inside it.'
  );
}

export function folderTooDeep(limit: number): OrganisationError {
  return new OrganisationError(
    'FOLDER_TOO_DEEP',
    `Folders can be nested ${limit} levels deep. Use tags to cut across the tree instead.`
  );
}

export function tooManyFolders(limit: number): OrganisationError {
  return new OrganisationError(
    'TOO_MANY_FOLDERS',
    `This vault already has the maximum of ${limit} folders.`
  );
}

export function tooManyTags(limit: number): OrganisationError {
  return new OrganisationError(
    'TOO_MANY_TAGS',
    `This vault already has the maximum of ${limit} tags.`
  );
}

export function invalidName(reason: string): OrganisationError {
  return new OrganisationError('INVALID_NAME', `That name cannot be used: ${reason}.`);
}

export function duplicateTagName(): OrganisationError {
  return new OrganisationError(
    'DUPLICATE_TAG_NAME',
    'Another tag already has that name. Merge the two tags if that is what you meant.'
  );
}

export function invalidTagColour(): OrganisationError {
  return new OrganisationError(
    'INVALID_TAG_COLOUR',
    'A tag colour must be one of the colours this theme defines.'
  );
}

export function mergeIntoSelf(): OrganisationError {
  return new OrganisationError('MERGE_INTO_SELF', 'A tag cannot be merged into itself.');
}

export function noSuchSavedSearch(): OrganisationError {
  return new OrganisationError(
    'NO_SUCH_SAVED_SEARCH',
    'That saved search no longer exists in this vault.'
  );
}

export function tooManySavedSearches(limit: number): OrganisationError {
  return new OrganisationError(
    'TOO_MANY_SAVED_SEARCHES',
    `This vault already has the maximum of ${String(limit)} saved searches.`
  );
}

export function duplicateSearchName(): OrganisationError {
  return new OrganisationError(
    'DUPLICATE_SEARCH_NAME',
    'A saved search with that name already exists.'
  );
}

/**
 * `reason` comes from `savedSearchProblem`, which is written to be readable at the end of
 * this sentence and never to quote the value it is complaining about — a query can carry a
 * fragment of a record's title, and this message ends up in a banner.
 */
export function invalidSavedSearch(reason: string): OrganisationError {
  return new OrganisationError('INVALID_SAVED_SEARCH', `That search cannot be saved — ${reason}.`);
}
