// SPDX-License-Identifier: GPL-3.0-or-later
import type { ConflictChoice, MergeConflict, MergeReport } from '@shared/model/sync.js';

/**
 * What "settled" means, and nothing else.
 *
 * The merged document is **provisional while any conflict is unresolved** — that is the whole
 * reason the merge engine exists, and it is the one property this screen must not get wrong. A
 * half-resolved merge that looks applied is the last-writer-wins behaviour the engine was
 * written to avoid, arriving through the front door instead of the back.
 *
 * So the arithmetic lives here, pure and testable, rather than inside a component where it would
 * be reachable only by mounting React and provable only by clicking. Everything the screen
 * enables or disables is derived from {@link summarise}.
 *
 * ## The four states a conflict can be in
 *
 * `MergeResolution` has three values and they are not enough, because it cannot express "the
 * user has picked a side but the merge has not been re-run with it yet" — which is precisely
 * the state a resolver spends its whole life in. {@link ConflictStatus} adds it:
 *
 *  - `'needs-choice'` — unresolved by the engine, unanswered by the user. This is what a
 *    remaining count counts.
 *  - `'chosen'` — the user has picked a side. Either locally (not yet sent) or already folded
 *    in by a previous `resolve`, which the engine reports back as `resolution: 'user'`.
 *  - `'auto'` — settled by a policy rule, and *overridable*. The engine reads
 *    `MergeOptions.resolutions` for these too, so a user who disagrees with "the longer
 *    retention wins" can say so. Shown, never hidden.
 *  - `'combined'` — both sides contributed and there is no question to ask. The one case is a
 *    record whose attachment lists were merged; `applied: 'merged'` is what marks it, and the
 *    engine documents that it is deliberately not wired into its own resolution path. Offering
 *    a choice here would be offering a button that cannot change anything.
 */

export type ConflictStatus = 'needs-choice' | 'chosen' | 'auto' | 'combined';

/** Conflict id → the side the user picked. Sent to `resolve` whole, never as a delta. */
export type Selections = ReadonlyMap<string, ConflictChoice>;

export const NO_SELECTIONS: Selections = new Map<string, ConflictChoice>();

/**
 * True when this conflict is a question at all.
 *
 * Keyed off `applied === 'merged'` rather than off the conflict kind, because `AppliedSide`
 * already says exactly this: `'merged'` is documented as "what an id-keyed field looks like when
 * both sides contributed", and saying `'ours'` there would be a lie. A kind-based test would be
 * a second classification that could disagree with the type.
 */
export function isChoosable(conflict: MergeConflict): boolean {
  return conflict.applied !== 'merged';
}

export function statusOf(conflict: MergeConflict, selections: Selections): ConflictStatus {
  if (!isChoosable(conflict)) return 'combined';
  if (selections.has(conflict.id)) return 'chosen';
  switch (conflict.resolution) {
    case 'user':
      return 'chosen';
    case 'policy':
      return 'auto';
    case 'unresolved':
      return 'needs-choice';
  }
}

/**
 * The side that would be kept if the merge were re-run right now.
 *
 * The local selection wins over the report, because the report describes the *previous* run. For
 * a conflict the engine settled itself, `applied` is the answer — narrowed away from `'merged'`,
 * which {@link isChoosable} has already excluded from every path that reaches here.
 */
export function effectiveChoice(
  conflict: MergeConflict,
  selections: Selections
): ConflictChoice | null {
  const picked = selections.get(conflict.id);
  if (picked !== undefined) return picked;
  if (!isChoosable(conflict)) return null;
  if (conflict.resolution === 'unresolved') return null;
  return conflict.applied === 'merged' ? null : conflict.applied;
}

/**
 * Seeds the local selection map from a report.
 *
 * Two jobs. A report arriving with `resolution: 'user'` conflicts is a merge that has already
 * been resolved once — reopening it must not present those as unanswered. And the resolutions
 * map sent to `resolve` has to keep carrying them: the engine re-runs from scratch every time,
 * so a choice dropped from the map is a choice silently reverted.
 *
 * Policy decisions are deliberately **not** seeded. They are the engine's answer, not the
 * user's, and pinning them into the map would freeze a rule that should keep applying as the
 * rest of the merge changes around it.
 */
export function seedSelections(report: MergeReport): Selections {
  const seeded = new Map<string, ConflictChoice>();
  for (const conflict of report.conflicts) {
    if (!isChoosable(conflict)) continue;
    if (conflict.resolution !== 'user') continue;
    if (conflict.applied === 'merged') continue;
    seeded.set(conflict.id, conflict.applied);
  }
  return seeded;
}

/**
 * Carries selections across a re-merge.
 *
 * Conflict ids are stable, deterministic and independent of which document was passed first —
 * the merge engine guarantees that precisely so this function can exist. What it must still do
 * is **drop selections whose conflict is gone**: answering one question can remove another (a
 * record kept from their side no longer disagrees about its own fields), and a map still
 * carrying the dead id would send the engine an answer to a question it did not ask. Harmless
 * today, wrong the moment an id is ever reused.
 *
 * Seeded entries from the new report are folded in, so a choice the engine has already absorbed
 * survives a round trip that dropped it locally.
 */
export function carryOver(previous: Selections, next: MergeReport): Selections {
  const live = new Set(next.conflicts.map((conflict) => conflict.id));
  const carried = new Map<string, ConflictChoice>();
  for (const [id, choice] of previous) {
    if (live.has(id)) carried.set(id, choice);
  }
  for (const [id, choice] of seedSelections(next)) {
    if (!carried.has(id)) carried.set(id, choice);
  }
  return carried;
}

/** The map `MergeResolveRequest.choices` wants: a plain object, pruned to live conflicts. */
export function toResolutions(
  selections: Selections,
  report: MergeReport
): Readonly<Record<string, ConflictChoice>> {
  const live = new Set(report.conflicts.map((conflict) => conflict.id));
  const out: Record<string, ConflictChoice> = {};
  for (const [id, choice] of selections) {
    if (live.has(id)) out[id] = choice;
  }
  return out;
}

export interface ResolutionSummary {
  /** Conflicts that are a question at all — `'combined'` excluded. */
  readonly choosable: number;
  /** Still waiting for the user. The number the screen counts down. */
  readonly remaining: number;
  /** Answered by the user, locally or in a previous round. */
  readonly chosen: number;
  /** Settled by a policy rule and left alone. Overridable, and shown. */
  readonly auto: number;
  /** Both sides kept; no question to ask. */
  readonly combined: number;
  /**
   * True when a local selection has not yet been folded into a merge.
   *
   * The gate between "the user has answered everything" and "the engine agrees". The merged
   * document is still the *previous* one until `resolve` has run again, so this being true is
   * what stops the apply button lighting up a round early.
   */
  readonly needsRemerge: boolean;
  /**
   * The only condition under which anything may be written.
   *
   * Three separate facts, deliberately ANDed rather than collapsed: nothing is waiting on the
   * user, nothing is waiting on the engine, and the engine's own `requiresResolution` — the
   * authority, computed where both documents actually are — says so too.
   */
  readonly readyToApply: boolean;
}

/** True when the last merge already ran with exactly this selection folded in. */
function absorbed(conflict: MergeConflict, selections: Selections): boolean {
  const picked = selections.get(conflict.id);
  if (picked === undefined) return true;
  return conflict.resolution === 'user' && conflict.applied === picked;
}

export function summarise(report: MergeReport, selections: Selections): ResolutionSummary {
  let choosable = 0;
  let remaining = 0;
  let chosen = 0;
  let auto = 0;
  let combined = 0;
  let needsRemerge = false;

  for (const conflict of report.conflicts) {
    const status = statusOf(conflict, selections);
    if (status === 'combined') {
      combined += 1;
      continue;
    }
    choosable += 1;
    switch (status) {
      case 'needs-choice':
        remaining += 1;
        break;
      case 'chosen':
        chosen += 1;
        // A choice the engine has not yet seen. The report describes the *previous* run, so a
        // selection is only absorbed when that run both saw a user choice and applied this
        // side. Testing `resolution === 'unresolved'` alone would miss the two cases that
        // matter: overriding a policy decision, and changing a previous answer to the other
        // side. Both leave `resolution` looking settled while the merged document is stale.
        if (!absorbed(conflict, selections)) needsRemerge = true;
        break;
      case 'auto':
        auto += 1;
        break;
    }
  }

  return {
    choosable,
    remaining,
    chosen,
    auto,
    combined,
    needsRemerge,
    readyToApply: remaining === 0 && !needsRemerge && !report.requiresResolution,
  };
}

/**
 * Records a choice.
 *
 * Returns a new map rather than mutating, so React state updates are a plain assignment and a
 * stale render cannot show a selection the state does not hold. `null` clears — used by the
 * "undo this answer" affordance, which exists because nothing is written until apply and an
 * answer given by mistake must be takeable back.
 */
export function choose(
  selections: Selections,
  conflictId: string,
  choice: ConflictChoice | null
): Selections {
  const next = new Map(selections);
  if (choice === null) next.delete(conflictId);
  else next.set(conflictId, choice);
  return next;
}
