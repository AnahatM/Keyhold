// SPDX-License-Identifier: GPL-3.0-or-later
import type { ConflictChoice, MergeConflict } from '@shared/model/sync.js';
import { hidesValue } from './conflict-language.js';
import { statusOf, type Selections } from './resolution-state.js';

/**
 * Where the line is drawn on answering many conflicts at once, and why it is drawn there.
 *
 * ## The problem
 *
 * Four hundred conflicts cannot be four hundred deliberate clicks. Nobody does that; they close
 * the window, or they find the button that ends it and press that. So the screen has to offer a
 * way through — and the way through is exactly the button that makes this entire engine
 * pointless if it is the easy default. "Keep mine for everything" *is* last-writer-wins. Adding
 * it as the primary action would mean the merge engine, the conflict projection, the pre-merge
 * backup and this screen all exist to put a nicer label on the behaviour they were built to
 * prevent.
 *
 * ## The line
 *
 * The distinction that carries the weight is **not** how many conflicts a sweep settles. It is
 * whether the user can see what they are discarding.
 *
 *  - **Within one named subject** — one record, one folder, one tag — everything may be swept,
 *    including hidden values. This is not bulk in the dangerous sense: the scope is a single
 *    thing the user can name and is looking at, "keep this device's version of GitHub" is one
 *    judgement about one credential, and it is the judgement a person actually wants to make.
 *    Six clicks to say one thing is friction, not safety.
 *
 *  - **Across subjects** — only conflicts whose values are fully on screen. A tag, a folder
 *    name, a favourite flag, an expiry date: both sides are rendered, discarding one loses
 *    nothing the user cannot see and re-pick, and the other file is not deleted either way. This
 *    is what actually gets somebody through four hundred, because in a two-way merge most of
 *    those four hundred are this.
 *
 *  - **Never across subjects**: anything whose value is hidden ({@link hidesValue} — password,
 *    notes, security questions, custom fields), and every `record-delete-vs-edit`. A button
 *    sweeping those says "discard forty passwords I have not seen" or "trash eleven records I
 *    have not looked at", and there is no wording that makes that an informed decision. These
 *    are answered one at a time, and the screen says how many are left of them specifically.
 *
 * ## Three further rules that make the line hold
 *
 * **There is no whole-report sweep, at any scope.** Not as a hidden option, not behind a
 * confirmation. The two scopes below are the only ones, and neither of them can reach every
 * conflict in a report that contains a hidden value or a trashed record.
 *
 * **A sweep never overwrites an answer.** It only touches conflicts still in `'needs-choice'`.
 * A user who carefully answered nine rows and then swept the rest must not find their nine
 * quietly replaced — and a policy decision the engine made is left alone for the same reason.
 *
 * **A sweep writes nothing.** It sets selections, exactly like clicking would, and nothing is
 * applied until the whole report is settled and re-merged. Every sweep is reversible right up to
 * the moment of writing, which is what makes offering one defensible at all.
 */

export type SweepScope = 'one-target' | 'across-targets';

/** Why a conflict was left out of a sweep, in the words the screen shows. */
export const SWEEP_REFUSALS = {
  hidden: {
    one: 'hides a value, so it can only be answered on its own — open the record to compare',
    many: 'hide a value, so they can only be answered one at a time — open the record to compare',
  },
  trashed: {
    one: 'had its record trashed in one file and edited in the other, which is never settled in bulk',
    many: 'had their records trashed in one file and edited in the other, which is never settled in bulk',
  },
} as const;
export type SweepRefusalReason = keyof typeof SWEEP_REFUSALS;

export interface SweepRefusal {
  readonly conflict: MergeConflict;
  readonly reason: SweepRefusalReason;
}

export interface SweepPlan {
  readonly scope: SweepScope;
  readonly choice: ConflictChoice;
  /** Conflict ids this sweep would answer. */
  readonly willSet: readonly string[];
  /** Unanswered conflicts the scope refuses to touch, with the reason for each. */
  readonly refused: readonly SweepRefusal[];
  /** Already answered, settled by policy, or not a question. Counted, never changed. */
  readonly untouched: number;
}

/**
 * Why a conflict is out of reach of an across-subjects sweep, or `null` if it is not.
 *
 * `record-delete-vs-edit` is tested by kind rather than by its sides, because both of its sides
 * are plain timestamps — perfectly visible, and completely beside the point. What is being
 * discarded is a record, not a date.
 */
export function acrossTargetRefusal(conflict: MergeConflict): SweepRefusalReason | null {
  if (conflict.kind === 'record-delete-vs-edit') return 'trashed';
  if (hidesValue(conflict)) return 'hidden';
  return null;
}

/**
 * What a sweep over these conflicts would do, without doing it.
 *
 * Separate from {@link applySweep} so the button can say "this answers 312; 88 need you" before
 * it is pressed. A bulk control that reports its own scope after the fact is a bulk control
 * nobody trusts the second time.
 */
export function planSweep(
  conflicts: readonly MergeConflict[],
  selections: Selections,
  scope: SweepScope,
  choice: ConflictChoice
): SweepPlan {
  const willSet: string[] = [];
  const refused: SweepRefusal[] = [];
  let untouched = 0;

  for (const conflict of conflicts) {
    if (statusOf(conflict, selections) !== 'needs-choice') {
      untouched += 1;
      continue;
    }
    const refusal = scope === 'across-targets' ? acrossTargetRefusal(conflict) : null;
    if (refusal !== null) {
      refused.push({ conflict, reason: refusal });
      continue;
    }
    willSet.push(conflict.id);
  }

  return { scope, choice, willSet, refused, untouched };
}

/**
 * Applies a plan, and only a plan.
 *
 * Takes the `SweepPlan` rather than the conflicts, so the set of ids that gets written is
 * provably the set the user was shown a count of. Handing this the conflicts again would let the
 * two diverge, which on this screen means a button whose label understated what it did.
 */
export function applySweep(selections: Selections, plan: SweepPlan): Selections {
  const next = new Map(selections);
  for (const id of plan.willSet) {
    // Re-checked rather than trusted: a plan built against an older selection map must not be
    // able to overwrite an answer given since. Sweeps are additive, always.
    if (!next.has(id)) next.set(id, plan.choice);
  }
  return next;
}

/**
 * The sentence under a sweep button.
 *
 * States what will happen and what will not, in that order, and never rounds the refused count
 * away. "Answers 312 of 400" without the other 88 is the half-truth that makes somebody think
 * they are finished.
 */
export function describeSweep(plan: SweepPlan): string {
  const side = plan.choice === 'ours' ? 'this device' : 'the other file';
  if (plan.willSet.length === 0) {
    return plan.refused.length === 0
      ? 'Nothing here is waiting for an answer.'
      : `Nothing can be answered in bulk here — ${countOf(plan.refused.length, 'conflict')} need you individually.`;
  }
  const answered = `Takes ${side} for ${countOf(plan.willSet.length, 'conflict')}.`;
  if (plan.refused.length === 0) return answered;
  return `${answered} ${countOf(plan.refused.length, 'conflict')} still need you individually.`;
}

/**
 * Every reason a sweep refused, named once with its count.
 *
 * Lives here rather than in the bar that renders it, so that the wording and the rule share one
 * home: a component writing its own sentence about `refusal.reason` is a second list of the
 * refusal reasons, and it is the copy that goes stale when a third reason is added.
 *
 * Nothing is rounded away and nothing is summarised as "some". A user told "88 were left out"
 * without being told *why* has been told they are not finished and given nothing to do about it.
 */
export function refusalSentence(plan: SweepPlan): string {
  const parts: string[] = [];
  for (const reason of Object.keys(SWEEP_REFUSALS) as readonly SweepRefusalReason[]) {
    const count = plan.refused.filter((refusal) => refusal.reason === reason).length;
    if (count === 0) continue;
    const copy = SWEEP_REFUSALS[reason];
    parts.push(`${count} ${count === 1 ? copy.one : copy.many}`);
  }
  return parts.length === 0 ? '' : `${parts.join('; ')}.`;
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
