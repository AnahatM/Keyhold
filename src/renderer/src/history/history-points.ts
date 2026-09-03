// SPDX-License-Identifier: GPL-3.0-or-later
import type { CredentialProjection } from '@shared/model/credential.js';
import type { HistoryPointRef } from '@shared/model/history.js';

/**
 * The points a comparison can be drawn between, and which pairs mean anything.
 *
 * `kh:history:compare` has existed end to end — declared, registered, implemented, tested —
 * with nothing in the renderer ever calling it. What was missing was not the diff but the
 * question: a timeline answers "what did this edit change", and the thing it cannot answer is
 * "what is different between the version from March and what I have now".
 *
 * Pure and separate from the panel that renders it, because the part worth getting right is
 * which pairs are offered, not the markup. Two of the rules below are only obvious once stated:
 *
 * **The current state is a point.** Almost every real comparison has it on one end — the
 * question is nearly always "what has changed since", not "what changed between two old
 * states". Leaving it out would make the common case unreachable.
 *
 * **A point compared with itself is not a comparison.** It is offered by the ordering below
 * (both selects list everything) and has to be refused somewhere, or the panel renders "nothing
 * changed" for a question nobody asked.
 */

export interface HistoryPoint {
  readonly ref: HistoryPointRef;
  /** What the option reads as. Distinct per point, so two rows can never look identical. */
  readonly label: string;
  /** When that state existed. Sorts the list and dates the option. */
  readonly at: number;
}

/**
 * Every state this record has been in, newest first.
 *
 * Newest first for the same reason the timeline is: the recent end is what people come to look
 * at. `current` leads, because it is one half of nearly every comparison.
 *
 * A version's `savedAt` is when that version was *superseded* — it is the snapshot taken before
 * an edit — so it dates the state, not the edit. Labelling them by number as well as date is
 * deliberate: several edits in one minute are common, and "3 September, 14:02" three times over
 * is a list nobody can pick from.
 */
export function historyPointsFor(credential: CredentialProjection): readonly HistoryPoint[] {
  const versions = [...credential.history]
    .sort((a, b) => b.versionNumber - a.versionNumber)
    .map((version) => ({
      ref: version.versionNumber satisfies HistoryPointRef,
      label: `Version ${String(version.versionNumber)} · ${dateLabel(version.savedAt)}`,
      at: version.savedAt,
    }));

  return [
    {
      ref: 'current',
      label: `Now · ${dateLabel(credential.meta.updatedAt)}`,
      at: credential.meta.updatedAt,
    },
    ...versions,
  ];
}

/**
 * Whether a comparison between these two points is worth asking the main process for.
 *
 * Equality is the whole rule. Order is not checked: comparing an old point *to* a newer one and
 * the reverse are both meaningful — "what did I lose" and "what did I gain" are different
 * questions — and the engine produces a correctly-directioned diff either way.
 */
export function isComparablePair(from: HistoryPointRef, to: HistoryPointRef): boolean {
  return from !== to;
}

/**
 * The pair to open with.
 *
 * The newest version against the current state — "what changed in the most recent edit",
 * which is the question already on screen, so the panel starts by agreeing with the timeline
 * rather than showing something the user has to re-read to understand.
 *
 * `null` when the record has no history: there is only one point, and nothing to compare it to.
 */
export function defaultComparison(
  points: readonly HistoryPoint[]
): { readonly from: HistoryPointRef; readonly to: HistoryPointRef } | null {
  const [current, previous] = points;
  if (current === undefined || previous === undefined) return null;
  return { from: previous.ref, to: current.ref };
}

function dateLabel(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
