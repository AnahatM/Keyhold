// SPDX-License-Identifier: GPL-3.0-or-later
import type { MergeMode, MergeReport } from '@shared/model/sync.js';
import type { StatusTone } from '../components/Feedback.js';
import type { ResolutionSummary } from './resolution-state.js';

/**
 * Saying which merge this was, before anybody starts clicking.
 *
 * Two-way and three-way are not an implementation detail with a user-facing shadow. They are two
 * different situations, and the number on the screen means something different in each:
 *
 *  - **Three-way** had a common ancestor, so it can tell an edit from a stale copy. A side that
 *    matches the ancestor did not change, and the other side is taken with no question. A
 *    conflict therefore means *both devices changed the same thing* — a genuine disagreement,
 *    and there will usually be very few.
 *  - **Two-way** had no ancestor, so "these differ" is all that is knowable. Every difference
 *    becomes a conflict, including every field only one device touched. A record present on one
 *    side only is **kept**, because absence and deletion are indistinguishable without a
 *    tombstone or an ancestor.
 *
 * A user facing four hundred conflicts is in a completely different situation from one facing
 * four, and most of the difference is which mode produced the number. Telling them afterwards is
 * useless; the notice goes above the list, before the first click, which is why this module
 * exists separately from the conflict copy.
 *
 * The honest framing matters too. Two-way being noisy is not a defect to apologise for — the
 * alternative is to guess, and guessing in a password manager loses passwords. The copy says
 * that, rather than "sorry, lots of conflicts".
 */

export const MERGE_MODE_HEADLINES: Readonly<Record<MergeMode, string>> = {
  'three-way': 'Both files changed since they last agreed',
  'two-way': 'These two files have never been merged before',
};

/**
 * The paragraph under the headline. Says what the mode can and cannot know, and what that
 * means for the list underneath — not how the algorithm works.
 */
export const MERGE_MODE_EXPLANATIONS: Readonly<Record<MergeMode, string>> = {
  'three-way':
    'Keyhold has a record of what these two files last agreed on, so it could tell which changes are new and take them without asking. Everything below is a field that changed in both files at once — a real disagreement, not just a difference.',
  'two-way':
    'There is no record of what these two files last agreed on, so Keyhold cannot tell an edit from an old copy. Every field that differs is listed below, including ones only one file changed. That is why the list is long: the alternative is guessing, and guessing here loses passwords.',
};

/** A second line, for the consequences that are specific to one mode. */
export const MERGE_MODE_CONSEQUENCES: Readonly<Record<MergeMode, string | null>> = {
  'three-way': null,
  'two-way':
    'Nothing has been deleted. A record that exists in only one of the two files is kept, because with no shared history Keyhold cannot tell a deletion from a record that was never there.',
};

/**
 * `'info'` for both, deliberately.
 *
 * A two-way merge is not a warning state: nothing is wrong, nothing is at risk, and the safety
 * copy has already been taken. Colouring it as a warning would spend the user's alarm on the
 * normal case and leave nothing for the row that actually trashes a record.
 */
export const MERGE_MODE_TONES: Readonly<Record<MergeMode, StatusTone>> = {
  'three-way': 'info',
  'two-way': 'info',
};

/** Never colour alone (WCAG 1.4.1) — two shapes, distinguishable in greyscale. */
export const MERGE_MODE_SYMBOLS: Readonly<Record<MergeMode, string>> = {
  'three-way': '⑂',
  'two-way': '⇄',
};

/**
 * Whether the ancestor column exists at all.
 *
 * `MergeConflict.base` is documented as always `null` in two-way mode, so the column would be a
 * permanently empty third of every row. Removing it is not a tidy-up: a "last agreed" column
 * full of dashes reads as "we agreed on nothing", which is a different and untrue statement.
 */
export function showsAncestor(mode: MergeMode): boolean {
  return mode === 'three-way';
}

/** Column headings. Deliberately concrete — "ours" and "theirs" name nothing a user can see. */
export const SIDE_HEADINGS = {
  ours: 'This device',
  theirs: 'The other file',
  base: 'What they last agreed',
} as const;

export interface MergeModeNotice {
  readonly headline: string;
  readonly explanation: string;
  readonly consequence: string | null;
  readonly tone: StatusTone;
  readonly symbol: string;
  /** For the accessible label on the notice region. */
  readonly modeLabel: string;
}

export const MERGE_MODE_LABELS: Readonly<Record<MergeMode, string>> = {
  'three-way': 'Three-way merge',
  'two-way': 'Two-way merge',
};

export function modeNotice(mode: MergeMode): MergeModeNotice {
  return {
    headline: MERGE_MODE_HEADLINES[mode],
    explanation: MERGE_MODE_EXPLANATIONS[mode],
    consequence: MERGE_MODE_CONSEQUENCES[mode],
    tone: MERGE_MODE_TONES[mode],
    symbol: MERGE_MODE_SYMBOLS[mode],
    modeLabel: MERGE_MODE_LABELS[mode],
  };
}

/**
 * The sentence above the list, counting what is left.
 *
 * Mode-dependent in its noun — "disagreements" in three-way, "differences" in two-way — because
 * those are different claims and only one of them is true in each mode. Calling a two-way
 * difference a disagreement tells the user their other device changed something it may never
 * have touched.
 */
export function remainingHeadline(report: MergeReport, summary: ResolutionSummary): string {
  const noun = report.mode === 'two-way' ? 'difference' : 'disagreement';
  if (summary.choosable === 0) {
    return report.mode === 'two-way'
      ? 'The two files hold the same values everywhere. Nothing to settle.'
      : 'Nothing was changed in both files at once. Nothing to settle.';
  }
  if (summary.remaining === 0) {
    return `All ${summary.choosable} ${noun}${summary.choosable === 1 ? '' : 's'} answered.`;
  }
  if (summary.remaining === summary.choosable) {
    return `${summary.choosable} ${noun}${summary.choosable === 1 ? '' : 's'} to settle.`;
  }
  return `${summary.remaining} of ${summary.choosable} ${noun}${summary.choosable === 1 ? '' : 's'} still to answer.`;
}

/**
 * The record counts, in a sentence, with the ancestor omitted in two-way mode.
 *
 * `MergeRecordCounts.base` is `null` there, and printing "0 records last agreed" from a null
 * would be a fabricated fact about the user's data on the screen asking them to trust a merge.
 */
export function countsSentence(report: MergeReport): string {
  const counts = report.counts;
  const parts = [
    `${counts.merged} record${counts.merged === 1 ? '' : 's'} after merging`,
    `${counts.added} new`,
    `${counts.updated} changed`,
    `${counts.unchanged} untouched`,
  ];
  if (counts.trashed > 0) parts.push(`${counts.trashed} in the trash`);
  if (counts.base !== null) parts.push(`${counts.base} when the two files last agreed`);
  return `${parts.join(', ')}.`;
}
