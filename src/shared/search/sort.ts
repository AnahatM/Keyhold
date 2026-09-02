// SPDX-License-Identifier: GPL-3.0-or-later
import type { CredentialProjection } from '../model/credential.js';

/**
 * Ordering the record list. **Total, stable, and pure.**
 *
 * Total is the whole point. A comparator that returns 0 for two different records leaves
 * their order up to whatever the engine's sort did last, and the list then reshuffles
 * between renders for no reason the user can see — worst of all under a "sort by last used"
 * where most records tie on `null`. So every comparison here falls through to `id`, which
 * is unique by construction, and the result is one fixed order per (records, options).
 */

// ── Keys ─────────────────────────────────────────────────────────────────────

export const SORT_KEYS = [
  'title',
  'username',
  'createdAt',
  'updatedAt',
  'passwordUpdatedAt',
  'lastUsedAt',
  'useCount',
  'relevance',
] as const;

export type SortKey = (typeof SORT_KEYS)[number];

export type SortDirection = 'asc' | 'desc';

/**
 * The direction each key is worth showing first.
 *
 * Ascending is the literal meaning of every key — including `relevance`, where the value
 * being compared is a score, so ascending really is worst-match-first. That is a trap for
 * a caller who just passes `'asc'` everywhere, so the sensible default per key lives here
 * rather than in whichever component asks. One list, one answer.
 */
export const DEFAULT_SORT_DIRECTION: Readonly<Record<SortKey, SortDirection>> = {
  title: 'asc',
  username: 'asc',
  createdAt: 'desc',
  updatedAt: 'desc',
  passwordUpdatedAt: 'desc',
  lastUsedAt: 'desc',
  useCount: 'desc',
  relevance: 'desc',
};

export interface SortOptions {
  readonly key: SortKey;
  /** Defaults to ascending — see `DEFAULT_SORT_DIRECTION` for what the UI should pass. */
  readonly direction?: SortDirection | undefined;
  /** Required by `relevance`; ignored otherwise. Build it with `scoresById`. */
  readonly scores?: ReadonlyMap<string, number> | undefined;
}

// ── The collator ─────────────────────────────────────────────────────────────

/**
 * One collator for the whole module, built once at import.
 *
 * `new Intl.Collator(...)` is expensive — it resolves locale data — and a comparator runs
 * O(n log n) times, so constructing one per comparison turns a 10,000-record sort into tens
 * of thousands of locale lookups. This is the single most load-bearing line in the file for
 * performance.
 *
 * `numeric` so "Item 10" follows "Item 9" instead of preceding it, which is how every user
 * who ever named a record `Server 2` expects it to go. `sensitivity: 'base'` so case and
 * accents do not create separate alphabetical groups — "iCloud" belongs next to "Ideas",
 * not in a capitals section of its own. That deliberately makes the collator return 0 for
 * strings that differ only in case, which is exactly why the `id` tiebreak below exists.
 *
 * The locale is the host's, on purpose: this sorts a list a specific person is looking at,
 * and their language's alphabet is the right one. Ordering is therefore stable and total on
 * any given machine, though not necessarily identical across locales.
 */
export const TITLE_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

// ── Comparison ───────────────────────────────────────────────────────────────

/** Numeric keys, and how to read each one. `null` only ever comes from `lastUsedAt`. */
const NUMERIC_ACCESSORS: Readonly<
  Record<
    Exclude<SortKey, 'title' | 'username' | 'relevance'>,
    (record: CredentialProjection) => number | null
  >
> = {
  createdAt: (record) => record.meta.createdAt,
  updatedAt: (record) => record.meta.updatedAt,
  passwordUpdatedAt: (record) => record.meta.passwordUpdatedAt,
  lastUsedAt: (record) => record.meta.lastUsedAt,
  useCount: (record) => record.meta.useCount,
};

/**
 * "Never used" sinks to the bottom, whichever way the sort runs.
 *
 * The alternative — treating `null` as 0 — puts every never-used record at one end
 * ascending and, worse, at the *top* descending, so the most prominent rows of a
 * "recently used" list would be records that have never been used at all. Since that reads
 * as a bug in every direction, nulls are pinned last and the direction never touches them.
 */
function compareNullness(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return 0;
}

function comparePrimaryAscending(
  a: CredentialProjection,
  b: CredentialProjection,
  key: SortKey,
  scores: ReadonlyMap<string, number> | undefined
): number {
  if (key === 'title') return TITLE_COLLATOR.compare(a.title, b.title);
  if (key === 'username') return TITLE_COLLATOR.compare(a.username, b.username);
  if (key === 'relevance') {
    // A record with no entry scored nothing — which is what an unmatched record scores too.
    return (scores?.get(a.id) ?? 0) - (scores?.get(b.id) ?? 0);
  }
  const read = NUMERIC_ACCESSORS[key];
  return (read(a) ?? 0) - (read(b) ?? 0);
}

/**
 * Compares two records. Returns 0 only when `a` and `b` are the same record.
 *
 * The `id` tiebreak stays ascending in a descending sort. Flipping it too would reverse the
 * order of every tied group when the user clicks the direction toggle, which looks like the
 * list rearranging itself for no reason.
 */
export function compareCredentials(
  a: CredentialProjection,
  b: CredentialProjection,
  options: SortOptions
): number {
  if (options.key === 'lastUsedAt') {
    const nulls = compareNullness(a.meta.lastUsedAt, b.meta.lastUsedAt);
    if (nulls !== 0) return nulls;
  }

  const primary = comparePrimaryAscending(a, b, options.key, options.scores);
  if (primary !== 0) return (options.direction ?? 'asc') === 'desc' ? -primary : primary;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Sorts a copy. The input list is never mutated — it usually belongs to a store. */
export function sortCredentials(
  records: readonly CredentialProjection[],
  options: SortOptions
): readonly CredentialProjection[] {
  return [...records].sort((a, b) => compareCredentials(a, b, options));
}
