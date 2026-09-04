// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo } from 'react';
import type { CredentialProjection } from '@shared/model/credential.js';
import { filterCredentials, parseQuery } from '@shared/search/index.js';
import { Icon } from '../components/Icon.js';
import { hasBeenUsed, SMART_VIEWS, type SmartViewId } from './smart-views.js';

/**
 * The saved views, rendered straight from `SMART_VIEWS`.
 *
 * There is not one `if` in this file about which view is which — every row is the same row.
 * That is the whole payoff of defining the views as data: "Expiring soon" would be an entry
 * in the array and this component would not change.
 *
 * Counts come from the same search engine the list pane uses, over the same records, so a
 * count can never disagree with the list it opens. A view that is a window rather than a set
 * (`countable: false`) shows no number instead of a misleading one.
 */

export interface SmartViewListProps {
  readonly records: readonly CredentialProjection[];
  readonly selectedViewId: SmartViewId | null;
  readonly onSelect: (viewId: SmartViewId) => void;
}

export function SmartViewList({
  records,
  selectedViewId,
  onSelect,
}: SmartViewListProps): React.JSX.Element {
  const counts = useMemo(() => {
    const result = new Map<SmartViewId, number>();
    for (const view of SMART_VIEWS) {
      if (!view.countable) continue;
      const matched = filterCredentials(records, {
        ...view.filter,
        query: parseQuery(view.queryText),
      });
      result.set(view.id, view.usedOnly ? matched.filter(hasBeenUsed).length : matched.length);
    }
    return result;
  }, [records]);

  return (
    <nav className="kh-sidebar__nav" aria-label="Views">
      <h2 className="kh-sidebar__group">Vault</h2>
      {SMART_VIEWS.map((view) => {
        const count = counts.get(view.id);
        return (
          <button
            key={view.id}
            type="button"
            className="kh-sidebar__item"
            aria-current={view.id === selectedViewId}
            title={view.description}
            onClick={() => {
              onSelect(view.id);
            }}
          >
            {/*
              No wrapper around the icon. The `kh-sidebar__symbol` slot existed to give
              emoji of wildly different advance widths a fixed gutter so the labels lined
              up; every icon in the set is drawn on the same 24 grid and rendered at the
              same em size, so the column is already straight and the extra element only
              hid an already-hidden `<svg>` a second time.
            */}
            <Icon name={view.icon} />
            <span className="kh-sidebar__item-label">{view.label}</span>
            {count !== undefined && (
              <span className="kh-sidebar__count">
                {count}
                <span className="kh-visually-hidden">{` record${count === 1 ? '' : 's'}`}</span>
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
