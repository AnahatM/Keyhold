// SPDX-License-Identifier: GPL-3.0-or-later
import { SORT_KEYS, type SortDirection, type SortKey } from '@shared/search/sort.js';

/**
 * What each sort key is called, and what its two directions are called.
 *
 * The engine has sorted by eight keys, with a sensible default direction per key, since it was
 * written. Nothing in the list ever offered a choice — `visibleCredentials` already takes
 * `SortOptions` and was only ever called without one.
 *
 * A `Record<SortKey, …>` rather than a list, so adding a key to `SORT_KEYS` is a compile error
 * here rather than an option that silently never appears (rule 8: the keys live in one place
 * and this names them, it does not restate them).
 *
 * **Direction labels are per key, and that is the point.** "Ascending" and "descending" are
 * accurate and useless: nobody thinks of their passwords as ascending. What they want to say is
 * "oldest first" or "most used first", and which words those are depends on what is being
 * sorted — for a date, ascending is *oldest*; for a count, ascending is *fewest*.
 */

export interface SortLabels {
  /** The key, as a person would name it. */
  readonly label: string;
  /** What ascending means for this key, in the user's terms. */
  readonly asc: string;
  /** And descending. */
  readonly desc: string;
}

export const SORT_LABELS: Readonly<Record<SortKey, SortLabels>> = {
  title: { label: 'Name', asc: 'A to Z', desc: 'Z to A' },
  username: { label: 'Username', asc: 'A to Z', desc: 'Z to A' },
  createdAt: { label: 'Date added', asc: 'Oldest first', desc: 'Newest first' },
  updatedAt: { label: 'Last edited', asc: 'Oldest first', desc: 'Newest first' },
  passwordUpdatedAt: {
    label: 'Password age',
    asc: 'Oldest password first',
    desc: 'Newest password first',
  },
  lastUsedAt: { label: 'Last used', asc: 'Longest ago first', desc: 'Most recent first' },
  useCount: { label: 'Times used', asc: 'Least used first', desc: 'Most used first' },
  // Only meaningful with a query behind it; the control hides it otherwise, because every
  // record scores the same on an empty box and the order reads as random.
  relevance: { label: 'Best match', asc: 'Worst match first', desc: 'Best match first' },
};

/** The keys worth offering right now. `relevance` needs a query to mean anything. */
export function offeredSortKeys(hasQuery: boolean): readonly SortKey[] {
  return SORT_KEYS.filter((key) => key !== 'relevance' || hasQuery);
}

export function directionLabel(key: SortKey, direction: SortDirection): string {
  return direction === 'asc' ? SORT_LABELS[key].asc : SORT_LABELS[key].desc;
}
