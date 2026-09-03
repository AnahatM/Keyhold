// SPDX-License-Identifier: GPL-3.0-or-later
import type { MergeReport } from '@shared/model/sync.js';
import {
  CONFLICT_FILTERS,
  CONFLICT_FILTER_LABELS,
  type ConflictFilter,
} from './conflict-groups.js';
import { remainingHeadline } from './merge-mode.js';
import type { ResolutionSummary } from './resolution-state.js';

/**
 * What is left, and a way to see only that.
 *
 * ## Why the bar is not a "percent complete"
 *
 * It is a determinate meter over a real denominator — answered out of answerable — and it is
 * labelled with both numbers rather than a percentage. "94%" on four hundred conflicts hides
 * that twenty-four passwords are still unanswered, and this is the one screen where the tail
 * matters more than the bulk: the last twenty-four are, by the design of the bulk rules, exactly
 * the ones that could not be swept.
 *
 * ## Why the filters are always visible
 *
 * "What is left" has to be one click away at all times or the countdown is a number with nowhere
 * to go. Each chip carries its own count, so choosing a filter is never a guess about whether it
 * will be empty, and `'needs-care'` is its own chip because "the ones I have to read carefully"
 * is a real category to a person and the only one the bulk rules refuse to touch.
 */

export interface MergeProgressBarProps {
  readonly report: MergeReport;
  readonly summary: ResolutionSummary;
  readonly filter: ConflictFilter;
  readonly counts: Readonly<Record<ConflictFilter, number>>;
  readonly onFilter: (filter: ConflictFilter) => void;
}

export function MergeProgressBar({
  report,
  summary,
  filter,
  counts,
  onFilter,
}: MergeProgressBarProps): React.JSX.Element {
  const answered = summary.choosable - summary.remaining;

  return (
    <div className="kh-merge-progress">
      <p className="kh-merge-progress__headline" aria-live="polite">
        {remainingHeadline(report, summary)}
      </p>

      <div
        className="kh-merge-progress__meter"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={summary.choosable}
        aria-valuenow={answered}
        aria-valuetext={`${answered} of ${summary.choosable} answered`}
      >
        <span
          className="kh-merge-progress__fill"
          style={{
            // A width, not a colour: the only inline style here, and it carries a number the
            // stylesheet cannot know. Every colour on this screen is a token.
            inlineSize:
              summary.choosable === 0 ? '100%' : `${(answered / summary.choosable) * 100}%`,
          }}
        />
      </div>

      <div className="kh-merge-progress__filters" role="group" aria-label="Show which conflicts">
        {CONFLICT_FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            className={`kh-merge-filter${option === filter ? ' kh-merge-filter--on' : ''}`}
            aria-pressed={option === filter}
            onClick={() => {
              onFilter(option);
            }}
          >
            {CONFLICT_FILTER_LABELS[option]}
            <span className="kh-merge-filter__count"> {counts[option]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
