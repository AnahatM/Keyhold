// SPDX-License-Identifier: GPL-3.0-or-later
import type { CredentialProjection } from '@shared/model/credential.js';
import type { FilterOptions } from '@shared/search/filter.js';
import type { SortOptions } from '@shared/search/sort.js';

/**
 * The saved views at the top of the sidebar — **as data, not as branches**.
 *
 * Every one of these is the same operation with different arguments: a `FilterOptions`
 * shape, an optional query string, and a sort. Written as a `switch` inside a component,
 * "Favourites" and "Trash" would be two code paths that drift, the counts would be computed
 * a third way, and adding "Expiring soon" would mean editing three files. Written as data,
 * adding a view is one entry in this array and the component does not change at all.
 *
 * ## Two fields that are not `FilterOptions`, and why
 *
 * `queryText` exists because two of these views are expressible in the query language and
 * nothing else: `is:untagged` has no structured equivalent in `FilterOptions`. Rather than
 * inventing a second predicate for "has no tags", the view carries the query text and the
 * caller composes it with whatever the user typed — one parser, one matcher.
 *
 * `usedOnly` exists because "Recently used" is a *sort* plus "has ever been used", and
 * `FilterOptions` has no predicate over `meta.lastUsedAt`. Adding one belongs in
 * `@shared/search`, which this module does not own. It is one declared boolean consumed by
 * one applier (`selection.ts`), so it stays data rather than becoming a branch.
 */

export const SMART_VIEW_IDS = [
  'all',
  'favourites',
  'recent',
  'untagged',
  'unfiled',
  'trash',
] as const;

export type SmartViewId = (typeof SMART_VIEW_IDS)[number];

export interface SmartView {
  readonly id: SmartViewId;
  readonly label: string;
  /**
   * A glyph, shown beside the label.
   *
   * Decoration with a purpose: these rows differ by icon and by text, never by colour, so
   * the sidebar stays readable for a colour-blind user (WCAG 1.4.1).
   */
  readonly symbol: string;
  /** One sentence, used as the row's tooltip and as its empty-state description. */
  readonly description: string;
  readonly filter: FilterOptions;
  /** Composed with the user's search text. Empty for most views. */
  readonly queryText: string;
  readonly sort: SortOptions;
  /** Caps the rendered list. `null` for no cap. */
  readonly limit: number | null;
  /** Restricts to records that have actually been used at least once. */
  readonly usedOnly: boolean;
  /**
   * Whether a count belongs next to the label.
   *
   * "Recently used" is a capped, ordered window rather than a set, so a number beside it
   * would either be the cap (meaningless) or the whole vault (misleading).
   */
  readonly countable: boolean;
}

/** How many records "Recently used" shows. A window, not a filter. */
export const RECENT_VIEW_LIMIT = 25;

/**
 * The view everything falls back to.
 *
 * Bound to a name rather than reached as `SMART_VIEWS[0]` so that `smartView`'s fallback is a
 * value the compiler knows exists. Indexing an array under `noUncheckedIndexedAccess` yields
 * `SmartView | undefined`, and the only ways to spend that are a non-null assertion — which
 * asserts a fact rather than establishing one — or this, which establishes it.
 */
const ALL_ITEMS_VIEW: SmartView = {
  id: 'all',
  label: 'All items',
  symbol: '🗝',
  description: 'Every record in the vault, except what is in the trash.',
  filter: {},
  queryText: '',
  sort: { key: 'title', direction: 'asc' },
  limit: null,
  usedOnly: false,
  countable: true,
};

export const SMART_VIEWS: readonly SmartView[] = [
  ALL_ITEMS_VIEW,
  {
    id: 'favourites',
    label: 'Favourites',
    symbol: '★',
    description: 'Records you starred.',
    filter: { favouritesOnly: true },
    queryText: '',
    sort: { key: 'title', direction: 'asc' },
    limit: null,
    usedOnly: false,
    countable: true,
  },
  {
    id: 'recent',
    label: 'Recently used',
    symbol: '🕘',
    description: `The last ${RECENT_VIEW_LIMIT} records you copied from or opened.`,
    filter: {},
    queryText: '',
    sort: { key: 'lastUsedAt', direction: 'desc' },
    limit: RECENT_VIEW_LIMIT,
    usedOnly: true,
    countable: false,
  },
  {
    id: 'untagged',
    label: 'Untagged',
    symbol: '🏷',
    description: 'Records with no tags — usually the ones that never got organised.',
    filter: {},
    queryText: 'is:untagged',
    sort: { key: 'title', direction: 'asc' },
    limit: null,
    usedOnly: false,
    countable: true,
  },
  {
    id: 'unfiled',
    label: 'Unfiled',
    symbol: '📄',
    description: 'Records that are in no folder.',
    filter: { folderId: null },
    queryText: '',
    sort: { key: 'title', direction: 'asc' },
    limit: null,
    usedOnly: false,
    countable: true,
  },
  {
    id: 'trash',
    label: 'Trash',
    symbol: '🗑',
    description: 'Deleted records, restorable until they are purged.',
    filter: { trashedOnly: true },
    queryText: '',
    sort: { key: 'updatedAt', direction: 'desc' },
    limit: null,
    usedOnly: false,
    countable: true,
  },
];

export const SMART_VIEW_BY_ID: ReadonlyMap<SmartViewId, SmartView> = new Map(
  SMART_VIEWS.map((view) => [view.id, view])
);

/**
 * The view a fresh session starts on.
 *
 * Read off the fallback view rather than written out again, so "where a session starts" and
 * "where an unknown id lands" cannot drift into two different answers (hard rule 8).
 */
export const DEFAULT_SMART_VIEW_ID: SmartViewId = ALL_ITEMS_VIEW.id;

export function smartView(id: SmartViewId): SmartView {
  // Unreachable while `id` is typed, but a persisted preference could outlive a renamed view,
  // so the lookup still has to answer for a miss.
  return SMART_VIEW_BY_ID.get(id) ?? ALL_ITEMS_VIEW;
}

/** Narrows an untrusted string — a persisted preference, say — to a known view id. */
export function isSmartViewId(value: string): value is SmartViewId {
  return (SMART_VIEW_IDS as readonly string[]).includes(value);
}

/**
 * The "has been used at least once" predicate.
 *
 * Exported so the applier and the count use literally the same function; two spellings of
 * "used" is exactly the kind of duplicate that makes a count disagree with the list under
 * it.
 */
export function hasBeenUsed(record: CredentialProjection): boolean {
  return record.meta.lastUsedAt !== null;
}
