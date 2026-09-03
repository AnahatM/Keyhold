// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A named query, stored in the vault.
 *
 * ## Where these live, and why the roadmap called it a decision
 *
 * Inside the encrypted body, on `VaultDocument` beside `folders` and `tags` — **not** in
 * `VaultSettings`, and not in machine preferences. Three things settled it:
 *
 * **A saved search is content, not configuration.** `VaultSettings` holds answers to "how
 * should this vault behave" — retention, thresholds, which health rules run. A saved search
 * is a thing the user made and named, exactly like a folder. Putting it in settings would
 * mean the merge engine treats it with `mergeSettings`' last-writer-wins, and losing
 * somebody's named query because the other machine saved a second later is not a trade
 * anyone would choose.
 *
 * **It is a property of the data, not of the machine.** `folder:banking has:totp` means
 * nothing against a different vault. Every scope decision already recorded in
 * `vault-document.ts` argues this way — the attachment caps, the health thresholds, the
 * breach-check flag — and the same argument lands in the same place here. A user who syncs
 * one `.keep` between a desktop and a laptop expects their saved searches on both, and a
 * file that is deliberately self-contained is the thing that can deliver that.
 *
 * **It costs no format change.** `parseVaultDocument` already reads `folders` and `tags`
 * additively (`?? []`), so a vault written before saved searches existed opens with none and
 * gains the field on its next save. No `documentVersion` bump, no migration, and an older
 * build reading a newer file ignores what it does not know — which is the behaviour that
 * makes the whole envelope worth having.
 *
 * ## The query is stored as text
 *
 * Not as a parsed tree. The parser in `@shared/search/query.ts` is the single authority on
 * what a query means, and storing its output would freeze today's interpretation into every
 * vault — so a fix to the parser would apply to what the user types and not to what they
 * saved. Text also survives a round-trip through an export and back, and it is what the
 * query bar puts in front of them when they open it.
 *
 * The consequence is that a saved search can become invalid if the query language changes.
 * That is the right failure: it shows up as a diagnostic in the query bar, where the user
 * can see and fix it, rather than as a filter that silently matches nothing.
 */

/** The longest name a saved search may carry. Long enough to be a sentence, short enough to list. */
export const SAVED_SEARCH_NAME_MAX = 80;

/**
 * The longest query text a saved search may carry.
 *
 * Generous, because a real query with several `tag:` terms gets long, and bounded because
 * this arrives from a file anyone can write. The parser is not the place to discover that a
 * megabyte of text was stored in a name field.
 */
export const SAVED_SEARCH_QUERY_MAX = 500;

/** How many a vault may hold. A list nobody can scan is not a shortcut. */
export const SAVED_SEARCH_MAX = 100;

export interface SavedSearch {
  readonly id: string;
  readonly name: string;
  /** The raw query text, exactly as it would be typed into the query bar. */
  readonly query: string;
  /**
   * Where it appears in the sidebar. Explicit rather than by creation time, so reordering is
   * possible later without the stored shape changing — the same reason `Folder` carries one.
   */
  readonly order: number;
  /** Epoch milliseconds. Used by the merge to break a tie between two edited copies. */
  readonly updatedAt: number;
}

/**
 * Whether a value is a usable saved search, and if not, why.
 *
 * Returns a reason rather than a boolean because both callers need one: the settings UI has
 * to tell the user what is wrong with the name they typed, and the document parser has to
 * decide whether to drop an entry that arrived from a file. A shared predicate that only
 * said "no" would have each of them inventing its own explanation.
 *
 * Never quotes the value in the reason. A query can contain a fragment of a record's title,
 * and a reason string ends up in error messages and logs.
 */
export function savedSearchProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'a saved search must be an object';
  }

  const candidate = value as Partial<SavedSearch>;

  if (typeof candidate.id !== 'string' || candidate.id === '') return 'it has no id';
  if (typeof candidate.name !== 'string') return 'its name is not text';

  const name = candidate.name.trim();
  if (name === '') return 'its name is empty';
  if (name.length > SAVED_SEARCH_NAME_MAX) {
    return `its name is longer than ${String(SAVED_SEARCH_NAME_MAX)} characters`;
  }

  if (typeof candidate.query !== 'string') return 'its query is not text';
  // An empty query is refused rather than treated as "everything". A saved search called
  // "All items" that matches all items is indistinguishable from the sidebar row that
  // already does that, and a user who saved one by accident would have no way to tell why
  // clicking it appears to do nothing.
  if (candidate.query.trim() === '') return 'its query is empty';
  if (candidate.query.length > SAVED_SEARCH_QUERY_MAX) {
    return `its query is longer than ${String(SAVED_SEARCH_QUERY_MAX)} characters`;
  }

  if (typeof candidate.order !== 'number' || !Number.isFinite(candidate.order)) {
    return 'it has no position';
  }
  if (typeof candidate.updatedAt !== 'number' || !Number.isFinite(candidate.updatedAt)) {
    return 'it has no modification time';
  }

  return null;
}

/**
 * Trims and clamps a saved search into its stored form.
 *
 * Applied on the way in from both the UI and a file, so the two cannot disagree about what
 * gets stored. Trimming the name but **not** the query is deliberate: leading whitespace in
 * a name is a typo, whereas the query is passed to a parser that has its own opinion about
 * whitespace, and quietly editing what the user typed before parsing it would make the
 * diagnostics point at text they never wrote.
 */
export function normaliseSavedSearch(search: SavedSearch): SavedSearch {
  return {
    id: search.id,
    name: search.name.trim().slice(0, SAVED_SEARCH_NAME_MAX),
    query: search.query.slice(0, SAVED_SEARCH_QUERY_MAX),
    order: search.order,
    updatedAt: search.updatedAt,
  };
}

/** Stored order, then name, so two entries that share a position still list predictably. */
export function bySavedSearchOrder(a: SavedSearch, b: SavedSearch): number {
  return a.order - b.order || a.name.localeCompare(b.name);
}
