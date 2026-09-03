// SPDX-License-Identifier: GPL-3.0-or-later
import { DEFAULT_SORT_DIRECTION, type SortDirection, type SortKey } from '@shared/search/sort.js';
import { Button } from '../components/Button.js';
import { SORT_LABELS, directionLabel, offeredSortKeys } from './sort-labels.js';
import { useCredentials } from './credential-store.js';

/**
 * Choosing the order of the list.
 *
 * The engine has sorted by eight keys since it was written, `visibleCredentials` has taken a
 * `SortOptions` the whole time, and nothing ever passed one. This is the missing control, not a
 * new capability.
 *
 * **Two controls, not one menu of sixteen.** A single list of "Name A–Z / Name Z–A / Oldest
 * first / Newest first / …" is the combinatorial version and it grows every time a key is
 * added. A key picker plus a direction toggle stays two decisions however many keys exist, and
 * it matches how people describe what they want: *what* to sort by, then *which end* to start.
 *
 * **The direction button says what it will do in that key's own words.** "Ascending" is
 * accurate and useless — for a date it means oldest, for a count it means fewest, and the
 * mapping is in `sort-labels.ts` so a caller cannot get it the wrong way round.
 *
 * Choosing a key adopts that key's sensible default direction rather than keeping whatever was
 * set before. Switching from "Name A–Z" to "Last used" and getting *longest ago first* is the
 * literal reading of "keep the direction" and never what anybody meant.
 */

export function SortControl({ hasQuery }: { readonly hasQuery: boolean }): React.JSX.Element {
  const sort = useCredentials((state) => state.sort);
  const setSort = useCredentials((state) => state.setSort);

  const keys = offeredSortKeys(hasQuery);
  // What the list is doing right now, chosen or not, so the control never disagrees with the
  // order on screen. `visibleCredentials` picks relevance once there is a query and title
  // otherwise; this mirrors that rather than restating it as a second rule.
  const activeKey: SortKey = sort?.key ?? (hasQuery ? 'relevance' : 'title');
  const activeDirection: SortDirection = sort?.direction ?? DEFAULT_SORT_DIRECTION[activeKey];

  return (
    <div className="kh-sort">
      <label className="kh-sort__field" htmlFor="kh-sort-key">
        <span className="kh-visually-hidden">Sort by</span>
        <select
          id="kh-sort-key"
          className="kh-sort__select"
          value={activeKey}
          onChange={(event) => {
            const key = event.target.value as SortKey;
            setSort({ key, direction: DEFAULT_SORT_DIRECTION[key] });
          }}
        >
          {keys.map((key) => (
            <option key={key} value={key}>
              {SORT_LABELS[key].label}
            </option>
          ))}
        </select>
      </label>

      <Button
        variant="ghost"
        size="sm"
        // The label is the state, not the action: it says how the list is ordered now, and the
        // title says what pressing it does. A button reading "Newest first" that *makes* the
        // list newest-first when it already is would be a control you cannot read.
        title={`Switch to ${directionLabel(activeKey, activeDirection === 'asc' ? 'desc' : 'asc')}`}
        onClick={() => {
          setSort({ key: activeKey, direction: activeDirection === 'asc' ? 'desc' : 'asc' });
        }}
      >
        {directionLabel(activeKey, activeDirection)}
      </Button>
    </div>
  );
}
