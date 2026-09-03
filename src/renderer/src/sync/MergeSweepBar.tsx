// SPDX-License-Identifier: GPL-3.0-or-later
import type { ConflictChoice, MergeConflict } from '@shared/model/sync.js';
import {
  describeSweep,
  refusalSentence,
  type SweepPlan,
  type SweepScope,
} from './bulk-resolution.js';
import { SIDE_HEADINGS } from './merge-mode.js';

/**
 * The way through four hundred conflicts that does not make the engine pointless.
 *
 * ## What this offers, and what it refuses to
 *
 * It sweeps **only the conflicts whose values are on screen**, and only the ones currently
 * unanswered, and only within what the current filter is showing. Tags, folder names, favourite
 * flags, expiry dates: both sides are rendered, discarding one loses nothing the user cannot see
 * and re-pick, and the other file is not deleted either way.
 *
 * It cannot touch a password, a note, a security answer, a custom field, or a record one file
 * trashed. Those are counted and named in the refusal line instead, because a sweep that
 * silently skipped them would leave somebody believing they had finished.
 *
 * ## Why there is no "keep mine for everything"
 *
 * Because that is last-writer-wins with a nicer label, and it is the behaviour the merge engine,
 * the conflict projection and this entire screen exist to prevent. There is no scope, anywhere
 * in this folder, that settles a whole report from one side — the reasoning is written out in
 * full at the top of `bulk-resolution.ts`, and the tests beside it assert that no exported
 * function can be talked into it.
 *
 * ## Why both sides are offered symmetrically
 *
 * Neither button is primary, neither is first by preference, and the labels are "This device"
 * and "The other file" rather than "keep mine" and "discard theirs". The moment one of them
 * looks like the recommended action, it becomes the default, and a default here is a decision
 * made for the user about their own data.
 */

export interface MergeSweepBarProps {
  /** The conflicts currently on screen. Scoping to what is visible is what makes it explicit. */
  readonly conflicts: readonly MergeConflict[];
  readonly disabled: boolean;
  readonly onPreviewSweep: (
    conflicts: readonly MergeConflict[],
    scope: SweepScope,
    choice: ConflictChoice
  ) => SweepPlan;
  readonly onSweep: (plan: SweepPlan) => void;
}

export function MergeSweepBar({
  conflicts,
  disabled,
  onPreviewSweep,
  onSweep,
}: MergeSweepBarProps): React.JSX.Element | null {
  const ours = onPreviewSweep(conflicts, 'across-targets', 'ours');
  const theirs = onPreviewSweep(conflicts, 'across-targets', 'theirs');

  // Nothing sweepable and nothing refused means every conflict on screen is already answered.
  // A bar reading "0 can be answered together" there is noise about a job already done.
  if (ours.willSet.length === 0 && ours.refused.length === 0) return null;

  return (
    <section className="kh-merge-bulk" aria-label="Answer several at once">
      <p className="kh-merge-bulk__lead">
        {ours.willSet.length > 0
          ? `${ours.willSet.length} of these can be answered together, because both values are shown.`
          : 'None of these can be answered together.'}
      </p>

      {ours.willSet.length > 0 && (
        <div
          className="kh-merge-bulk__actions"
          role="group"
          aria-label="Answer the shown values together"
        >
          <button
            type="button"
            className="kh-merge-bulk__button"
            disabled={disabled}
            onClick={() => {
              onSweep(ours);
            }}
          >
            Keep {SIDE_HEADINGS.ours.toLowerCase()} for {ours.willSet.length}
          </button>
          <button
            type="button"
            className="kh-merge-bulk__button"
            disabled={disabled || theirs.willSet.length === 0}
            onClick={() => {
              onSweep(theirs);
            }}
          >
            Keep {SIDE_HEADINGS.theirs.toLowerCase()} for {theirs.willSet.length}
          </button>
        </div>
      )}

      {ours.refused.length > 0 && (
        <p className="kh-merge-bulk__refused">
          {ours.refused.length === 1
            ? '1 conflict here is left out of this:'
            : `${ours.refused.length} conflicts here are left out of this:`}{' '}
          {refusalSentence(ours)}
        </p>
      )}
      <p className="kh-visually-hidden">{describeSweep(ours)}</p>
    </section>
  );
}
