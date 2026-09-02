// SPDX-License-Identifier: GPL-3.0-or-later
import type { ImportWarning } from '@shared/model/import.js';
import { Badge } from '../components/Feedback.js';
import { groupWarnings, totalWarnings, warningHeadline } from './warning-groups.js';
import './import.css';

/**
 * Everything the import could not carry, grouped, counted, and complete.
 *
 * **Nothing here collapses, truncates or paginates.** A "show 12 more" control on this list
 * would be the app deciding which of the user's losses are worth their attention, and the
 * whole reason the parsers name every one of them is that nobody can make that call on
 * someone else's vault. The engine has already done the only compression that is safe —
 * one line per column rather than one per row — so what is left is short enough to read.
 *
 * A warning never quotes a value. That invariant belongs to the parsers and is tested there;
 * this component must not undo it by rendering anything but `message`, `column` and `line`.
 */
export function WarningList({
  warnings,
}: {
  readonly warnings: readonly ImportWarning[];
}): React.JSX.Element {
  const groups = groupWarnings(warnings);
  const total = totalWarnings(groups);

  return (
    <section className="kh-import-warnings" aria-labelledby="kh-import-warnings-heading">
      <h4 className="kh-import-section__heading" id="kh-import-warnings-heading">
        What did not survive
      </h4>
      <p className="kh-import-section__lead">{warningHeadline(groups)}</p>

      {total === 0 ? null : (
        <div className="kh-import-warning-groups">
          {groups.map((group) => (
            <section
              key={group.kind}
              className={`kh-import-warning kh-import-warning--${group.severity}`}
            >
              <header className="kh-import-warning__header">
                {/*
                 * Tone plus a symbol plus a word. Severity must not be carried by the
                 * background colour alone — a user who cannot see the difference between
                 * the amber and the grey card still has to know which list costs them data.
                 */}
                <Badge
                  tone={group.severity === 'loss' ? 'warning' : 'info'}
                  symbol={group.severity === 'loss' ? '⚠' : 'ℹ'}
                >
                  {group.severity === 'loss' ? 'Lost' : 'Note'}
                </Badge>
                <h5 className="kh-import-warning__title">
                  {group.label} <span className="kh-import-warning__count">({group.count})</span>
                </h5>
              </header>
              <p className="kh-import-warning__description">{group.description}</p>
              <ul className="kh-import-warning__items">
                {group.warnings.map((warning, index) => (
                  <li key={`${warning.kind}-${warning.column ?? ''}-${warning.line ?? index}`}>
                    <span className="kh-import-warning__message">{warning.message}</span>
                    <WarningLocation warning={warning} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

/** Where the problem was — a column name, a line number, or both. Never a value. */
function WarningLocation({
  warning,
}: {
  readonly warning: ImportWarning;
}): React.JSX.Element | null {
  const parts: string[] = [];
  if (warning.column !== undefined) parts.push(`column “${warning.column}”`);
  if (warning.line !== undefined) parts.push(`line ${warning.line}`);
  if (parts.length === 0) return null;
  return <span className="kh-import-warning__where">{parts.join(', ')}</span>;
}
