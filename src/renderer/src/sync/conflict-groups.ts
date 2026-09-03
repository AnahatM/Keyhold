// SPDX-License-Identifier: GPL-3.0-or-later
import type { MergeConflict, MergeReport } from '@shared/model/sync.js';
import { hidesValue, targetKindOf } from './conflict-language.js';
import {
  nameTarget,
  type MergeTargetKind,
  type MergeTargetNames,
  type TargetName,
} from './merge-targets.js';
import { statusOf, type Selections } from './resolution-state.js';

/**
 * Four hundred conflicts, made navigable.
 *
 * A two-way merge produces a conflict for **every** difference, because with no ancestor
 * "these differ" is all that is knowable. Four hundred is therefore not a pathological case, it
 * is Tuesday for anyone who has been editing two copies for a month. A flat list of four hundred
 * rows is not a list anybody reads; it is a wall somebody clicks through.
 *
 * Three things make it navigable, and this module is all three:
 *
 *  - **Grouping by subject.** Six rows about one record read as one decision about that record.
 *    Six rows scattered through four hundred read as six unrelated problems.
 *  - **A filter.** "What is left" has to be one click away, permanently, or the countdown is a
 *    number with nowhere to go.
 *  - **A stable order.** See below — this is the part that is easy to get wrong.
 *
 * ## Why the order never changes as you answer
 *
 * The obvious design sorts unanswered conflicts to the top. It is wrong, and it is wrong in a
 * way that only shows up at scale: every answer reorders the list under the cursor, so the row
 * the user was about to click is now somewhere else and the row now under the cursor is one they
 * have already decided. On four hundred rows that is a guaranteed misclick, on the one screen
 * where a misclick discards a password.
 *
 * So the order is the engine's own — document order, deterministic, and identical between two
 * merges of the same pair. Answering a row changes how it looks and never where it is. Moving
 * through the remaining ones is the filter's job.
 */

export type ConflictFilter = 'all' | 'remaining' | 'answered' | 'needs-care';

/** The filter chips, in the order they are shown. Also the runtime list for validation. */
export const CONFLICT_FILTERS: readonly ConflictFilter[] = [
  'all',
  'remaining',
  'needs-care',
  'answered',
];

export const CONFLICT_FILTER_LABELS: Readonly<Record<ConflictFilter, string>> = {
  all: 'Everything',
  remaining: 'Still to answer',
  'needs-care': 'Hidden values',
  answered: 'Answered',
};

/**
 * One heading per record, folder, tag or setting the merge is arguing about.
 *
 * `key` is `kind:targetId` rather than `targetId` alone, because a folder and a record are
 * allowed to share an id in principle and a collision here would silently merge two subjects
 * into one card.
 */
export interface ConflictGroup {
  readonly key: string;
  readonly targetKind: MergeTargetKind;
  readonly targetId: string;
  readonly target: TargetName;
  readonly conflicts: readonly MergeConflict[];
  /** Still waiting for the user, within this group. */
  readonly remaining: number;
  /** Answered by the user, within this group. */
  readonly answered: number;
  /** Conflicts in this group whose value is not, and cannot be, on screen. */
  readonly hidden: number;
}

/**
 * Groups every conflict in the report by its subject, in engine order.
 *
 * `'combined'` conflicts are kept rather than dropped. They are not questions, but they are
 * things the merge did to a record the user is looking at, and a card that silently omitted
 * "both attachment lists were kept" would be a card that under-reports what happened.
 */
export function groupConflicts(
  report: MergeReport,
  names: MergeTargetNames,
  selections: Selections
): readonly ConflictGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, MergeConflict[]>();

  for (const conflict of report.conflicts) {
    const key = `${targetKindOf(conflict)}:${conflict.targetId}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, [conflict]);
      order.push(key);
    } else {
      existing.push(conflict);
    }
  }

  return order.map((key) => {
    const conflicts = byKey.get(key) ?? [];
    // `order` is built from `byKey`'s own keys, so the first conflict always exists. The
    // fallbacks below exist because `noUncheckedIndexedAccess` cannot know that, and they are
    // deliberately inert rather than clever.
    const first = conflicts[0];
    const targetKind: MergeTargetKind = first === undefined ? 'record' : targetKindOf(first);
    const targetId = first?.targetId ?? '';

    let remaining = 0;
    let answered = 0;
    let hidden = 0;
    for (const conflict of conflicts) {
      const status = statusOf(conflict, selections);
      if (status === 'needs-choice') remaining += 1;
      if (status === 'chosen') answered += 1;
      if (hidesValue(conflict)) hidden += 1;
    }

    return {
      key,
      targetKind,
      targetId,
      target: nameTarget(targetKind, targetId, names),
      conflicts,
      remaining,
      answered,
      hidden,
    };
  });
}

function matchesFilter(
  conflict: MergeConflict,
  filter: ConflictFilter,
  selections: Selections
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'remaining':
      return statusOf(conflict, selections) === 'needs-choice';
    case 'answered':
      return statusOf(conflict, selections) === 'chosen';
    case 'needs-care':
      return hidesValue(conflict);
  }
}

/**
 * The groups a filter leaves, with their conflicts narrowed to the matching ones.
 *
 * Empty groups are dropped. A permanent "GitHub — nothing here" heading under the "still to
 * answer" filter is noise that trains people to skim headings, which is the opposite of what
 * grouping is for.
 */
export function filterGroups(
  groups: readonly ConflictGroup[],
  filter: ConflictFilter,
  selections: Selections
): readonly ConflictGroup[] {
  if (filter === 'all') return groups;
  const filtered: ConflictGroup[] = [];
  for (const group of groups) {
    const conflicts = group.conflicts.filter((conflict) =>
      matchesFilter(conflict, filter, selections)
    );
    if (conflicts.length === 0) continue;
    filtered.push({ ...group, conflicts });
  }
  return filtered;
}

/** The number beside each filter chip. Counts conflicts, not groups — the user counts rows. */
export function filterCounts(
  report: MergeReport,
  selections: Selections
): Readonly<Record<ConflictFilter, number>> {
  const counts: Record<ConflictFilter, number> = {
    all: 0,
    remaining: 0,
    answered: 0,
    'needs-care': 0,
  };
  for (const conflict of report.conflicts) {
    for (const filter of CONFLICT_FILTERS) {
      if (matchesFilter(conflict, filter, selections)) counts[filter] += 1;
    }
  }
  return counts;
}

/**
 * How many groups are rendered before "show more".
 *
 * Not virtualisation, which would be the wrong trade here: a virtualised list breaks
 * find-in-page and screen-reader browse mode, and this screen's whole purpose is reading. A page
 * size does not — everything rendered is really in the DOM, and the button that grows the page
 * says how much is left.
 */
export const GROUP_PAGE_SIZE = 20;

/** Groups above this count start collapsed, so the page opens as an index rather than a wall. */
export const AUTO_EXPAND_LIMIT = 8;

export interface GroupPage {
  readonly shown: readonly ConflictGroup[];
  readonly hiddenGroups: number;
  readonly hiddenConflicts: number;
}

export function pageOfGroups(groups: readonly ConflictGroup[], pages: number): GroupPage {
  const limit = Math.max(1, pages) * GROUP_PAGE_SIZE;
  const shown = groups.slice(0, limit);
  const rest = groups.slice(limit);
  return {
    shown,
    hiddenGroups: rest.length,
    hiddenConflicts: rest.reduce((total, group) => total + group.conflicts.length, 0),
  };
}

/**
 * Which groups start open.
 *
 * All of them for a small merge, where collapsing would just add a click to every row. None of
 * them past the limit, where the collapsed headings are the index that makes the screen usable —
 * each one already carries its own remaining count, so nothing is hidden, only folded.
 */
export function initiallyExpanded(groups: readonly ConflictGroup[]): ReadonlySet<string> {
  if (groups.length > AUTO_EXPAND_LIMIT) return new Set<string>();
  return new Set(groups.map((group) => group.key));
}
