// SPDX-License-Identifier: GPL-3.0-or-later

import type { ExportLoss } from '@shared/model/export.js';
import { Badge } from '../components/Feedback.js';
import { groupLossesByKind } from './export-presentation.js';
import './export.css';

/**
 * What this export will not carry, grouped by how badly it will not carry it.
 *
 * The component that makes "it is impossible to export a CSV and be surprised that history
 * is gone" true. It is rendered on the confirm step, before anything is written, and again
 * on the result step, where the same list becomes a record of what actually happened.
 *
 * Every group is announced by a word (`Not in the file`) and a shape (`✕`) as well as a
 * colour, because a person who cannot separate the red chip from the grey one is exactly
 * the person this list exists for.
 *
 * A definition list rather than a bare `<ul>`: each entry is a field paired with what
 * happened to it, and `<dt>`/`<dd>` is what a screen reader reads as that pairing.
 */
export interface LossListProps {
  readonly losses: readonly ExportLoss[];
  /** Shown when nothing was lost. Say what that means, rather than rendering nothing. */
  readonly emptyNote: string;
  /** The accessible heading level, so the list nests correctly under either step. */
  readonly headingId?: string | undefined;
}

export function LossList({ losses, emptyNote, headingId }: LossListProps): React.JSX.Element {
  const groups = groupLossesByKind(losses);

  if (groups.length === 0) {
    return (
      <p className="kh-export-losses__empty" id={headingId}>
        <span className="kh-export-losses__symbol" aria-hidden="true">
          ✓
        </span>
        {emptyNote}
      </p>
    );
  }

  return (
    <div className="kh-export-losses" id={headingId}>
      {groups.map((group) => (
        <section key={group.kind} className="kh-export-losses__group">
          <h4 className="kh-export-losses__heading">
            <Badge tone={group.tone} symbol={group.icon}>
              {group.label}
            </Badge>
          </h4>
          <p className="kh-export-losses__meaning">{group.meaning}</p>

          <dl className="kh-export-losses__items">
            {group.losses.map((loss) => (
              <div className="kh-export-losses__item" key={`${loss.kind}:${loss.field}`}>
                <dt className="kh-export-losses__field">{loss.field}</dt>
                {/* The engine's own sentence, verbatim. Rewording it here would be a second
                    description of the same loss, and the engine's is the one that knows the
                    count. It never contains a field value — that is a property test. */}
                <dd className="kh-export-losses__message">{loss.message}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
