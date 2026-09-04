// SPDX-License-Identifier: GPL-3.0-or-later
import type { MergeReport } from '@shared/model/sync.js';
import { Badge } from '../components/Feedback.js';
import { groupNotes, notesHeadline, totalNotes } from './merge-notes.js';

/**
 * Everything the merge decided without asking.
 *
 * Not a footnote. Two of these kinds are load-bearing — `'attachment-needed'` is what makes an
 * attachment openable after the merge, and `'record-kept-unmatched'` is the sentence answering
 * "did this delete anything?" for every two-way merge — and both sort to the top under
 * "worth looking at".
 *
 * Open by default when anything needs attention, folded otherwise. A panel that is always open
 * competes with the conflicts for the reader's attention; a panel that is always folded is a
 * panel nobody opens. The condition is which of those costs more on this particular report.
 */

export interface MergeNotePanelProps {
  readonly report: MergeReport;
}

export function MergeNotePanel({ report }: MergeNotePanelProps): React.JSX.Element | null {
  const groups = groupNotes(report.notes);
  if (totalNotes(groups) === 0) return null;

  const needsAttention = groups.some((group) => group.severity === 'attention');

  return (
    <details className="kh-merge-notes" open={needsAttention}>
      <summary className="kh-merge-notes__summary">
        <span className="kh-merge-notes__title">What the merge decided on its own</span>
        <span className="kh-merge-notes__headline">{notesHeadline(groups)}</span>
      </summary>

      <ul className="kh-merge-notes__list">
        {groups.map((group) => (
          <li key={group.kind} className={`kh-merge-note kh-merge-note--${group.severity}`}>
            <span className="kh-merge-note__symbol" aria-hidden="true">
              {group.icon}
            </span>
            <div className="kh-merge-note__text">
              <span className="kh-merge-note__label">
                {group.label}
                <Badge tone={group.severity === 'attention' ? 'warning' : 'neutral'}>
                  {group.total !== null ? `${group.count} · ${group.total} total` : group.count}
                </Badge>
              </span>
              <span className="kh-merge-note__description">{group.description}</span>
            </div>
          </li>
        ))}
      </ul>

      {report.attachmentsToImport.length > 0 && (
        <p className="kh-merge-notes__attachments">
          {report.attachmentsToImport.length === 1
            ? '1 attachment will be copied across from the other file when this merge is applied.'
            : `${report.attachmentsToImport.length} attachments will be copied across from the other file when this merge is applied.`}
        </p>
      )}
    </details>
  );
}
