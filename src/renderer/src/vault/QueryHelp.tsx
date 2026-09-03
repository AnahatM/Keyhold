// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo, useState } from 'react';
import { parseQuery } from '@shared/search/query.js';
import { applySuggestion, suggestionsFor } from './query-suggestions.js';

/**
 * The two things the search box has always known and never said.
 *
 * **What it understood.** `parseQuery` produces user-facing diagnostics — an unterminated
 * quote, a dangling `-`, an unknown flag — every one of them recoverable and phrased for a
 * person. Nothing rendered them, so a typo in a query looked like a vault with nothing in it.
 * That is the worst possible reading of a search box on a password manager: the honest message
 * is "I did not understand that", and the silent one is "you do not have it".
 *
 * **What it accepts.** Six field prefixes and ten flags, parsed and tested since the engine was
 * written, discoverable only by reading the source. `QUERY_FIELDS` says in its own comment that
 * it is exported so a menu can render from it. This is that menu.
 *
 * Suggestions appear only while the box is focused and only when there is something to add, so
 * an ordinary word search is never interrupted by a list of syntax nobody asked about.
 */

export interface QueryHelpProps {
  readonly query: string;
  readonly focused: boolean;
  readonly onChange: (next: string) => void;
}

export function QueryHelp({ query, focused, onChange }: QueryHelpProps): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);

  const parsed = useMemo(() => parseQuery(query), [query]);
  const suggestions = useMemo(() => (focused ? suggestionsFor(query) : []), [query, focused]);

  // Diagnostics are shown whether or not the box has focus: a query that was misunderstood is
  // still misunderstood after clicking away, and the results on screen are its consequence.
  const showSuggestions = focused && !dismissed && suggestions.length > 0 && query.trim() !== '';

  if (parsed.diagnostics.length === 0 && !showSuggestions) return null;

  return (
    <div className="kh-query-help">
      {parsed.diagnostics.length > 0 && (
        <ul className="kh-query-help__diagnostics" role="status">
          {parsed.diagnostics.map((diagnostic) => (
            <li key={`${diagnostic.code}-${diagnostic.token}`}>{diagnostic.message}</li>
          ))}
        </ul>
      )}

      {showSuggestions && (
        <ul className="kh-query-help__suggestions">
          {suggestions.map((suggestion) => (
            <li key={suggestion.insert}>
              <button
                type="button"
                className="kh-query-help__suggestion"
                // `onMouseDown` rather than `onClick`: the box loses focus on mousedown, which
                // unmounts this list before a click can land on it. The classic autocomplete
                // bug, and the reason a suggestion that "does nothing" is usually this.
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(applySuggestion(query, suggestion.insert));
                }}
              >
                <span className="kh-query-help__token">{suggestion.label}</span>
                <span className="kh-query-help__hint">{suggestion.hint}</span>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="kh-query-help__dismiss"
              onMouseDown={(event) => {
                event.preventDefault();
                setDismissed(true);
              }}
            >
              Hide suggestions
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
