// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo } from 'react';
import type { CredentialProjection } from '@shared/model/credential.js';
import { filterCredentials, parseQuery } from '@shared/search/index.js';
import { bySavedSearchOrder, type SavedSearch } from '@shared/model/saved-search.js';
import { Icon } from '../components/Icon.js';
import { useSavedSearches } from './saved-search-store.js';

/**
 * The user's own saved views, under the built-in ones.
 *
 * Deliberately the same row, the same counting and the same shape as `SmartViewList`, because
 * a saved search *is* a smart view — one whose whole definition is its `queryText`. What it
 * is not is an entry in `SMART_VIEWS`: that array is a compile-time table with an exhaustive
 * id union behind it, and pushing runtime data into it would turn a type into a lie. So the
 * two lists render separately and share the engine, which is the part that must not diverge.
 *
 * ## The count is computed the same way the list pane computes it
 *
 * Through `parseQuery` and `filterCredentials`, over the same projections, so a count can
 * never disagree with the list it opens. A saved search whose query no longer parses simply
 * matches nothing, and that is the honest outcome — the query bar shows the parser's own
 * diagnostic when the row is opened, which is where a person can act on it.
 */

export interface SavedSearchListProps {
  readonly records: readonly CredentialProjection[];
  readonly selectedSearchId: string | null;
  readonly onSelect: (search: SavedSearch) => void;
}

export function SavedSearchList({
  records,
  selectedSearchId,
  onSelect,
}: SavedSearchListProps): React.JSX.Element | null {
  const searches = useSavedSearches((state) => state.searches);

  const ordered = useMemo(() => [...searches].sort(bySavedSearchOrder), [searches]);

  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const search of ordered) {
      result.set(search.id, filterCredentials(records, { query: parseQuery(search.query) }).length);
    }
    return result;
  }, [ordered, records]);

  // Nothing at all rather than an empty heading. A "Saved searches" group with no rows under
  // it reads as a feature that is broken; the way to get one is the Save button on the query
  // bar, which is where somebody is when the thought occurs to them.
  if (ordered.length === 0) return null;

  return (
    <nav className="kh-sidebar__nav" aria-label="Saved searches">
      <h2 className="kh-sidebar__group">Saved searches</h2>
      {ordered.map((search) => {
        const count = counts.get(search.id) ?? 0;
        return (
          <button
            key={search.id}
            type="button"
            className="kh-sidebar__item"
            aria-current={search.id === selectedSearchId}
            // The query itself, because it is the only thing that says what this row will do
            // and the name deliberately does not have to.
            title={search.query}
            onClick={() => {
              onSelect(search);
            }}
          >
            {/* Same mark for every row, and deliberately: a saved search is a query, and
                what distinguishes one row from another is its name, not its icon. */}
            <Icon name="search" />
            <span className="kh-sidebar__item-label">{search.name}</span>
            <span className="kh-sidebar__count">
              {count}
              <span className="kh-visually-hidden">{` record${count === 1 ? '' : 's'}`}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
