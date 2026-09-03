// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  AUTO_EXPAND_LIMIT,
  CONFLICT_FILTERS,
  filterCounts,
  filterGroups,
  groupConflicts,
  GROUP_PAGE_SIZE,
  initiallyExpanded,
  pageOfGroups,
} from './conflict-groups.js';
import { NO_SELECTIONS, type Selections } from './resolution-state.js';
import { conflict, names, report, secret } from './test-fixtures.js';

/**
 * Four hundred conflicts, made navigable — and the ordering rule that makes it safe.
 *
 * Fault injections performed:
 *
 *  1. `groupConflicts` sorting groups by `remaining` descending — fails "the order never changes
 *     as conflicts are answered".
 *  2. Keying groups on `targetId` alone rather than `kind:targetId` — fails "a folder and a
 *     record that share an id are two groups, not one".
 *  3. `filterGroups` keeping empty groups — fails "a filter drops the groups it emptied".
 *  4. `filterCounts` counting groups instead of conflicts — fails "the chips count conflicts,
 *     because that is what the user counts".
 *  5. `pageOfGroups` reporting `hiddenConflicts` as the group count — fails "says how many
 *     conflicts are off screen, not just how many groups".
 *  6. `initiallyExpanded` always returning every key — fails "a long merge opens as an index,
 *     not as a wall".
 */

const bigReport = (count: number) =>
  report({
    conflicts: Array.from({ length: count }, (_, index) =>
      conflict({ targetId: `rec-${index}`, field: 'title' })
    ),
  });

describe('grouping by subject', () => {
  it('puts every conflict about one record under one heading', () => {
    const grouped = groupConflicts(
      report({
        conflicts: [
          conflict({ targetId: 'rec-1', field: 'title' }),
          conflict({ targetId: 'rec-1', field: 'password', ours: secret(3), theirs: secret(9) }),
          conflict({ targetId: 'rec-2', field: 'title' }),
        ],
      }),
      names(),
      NO_SELECTIONS
    );

    expect(grouped).toHaveLength(2);
    expect(grouped[0]?.target.name).toBe('GitHub');
    expect(grouped[0]?.conflicts).toHaveLength(2);
    expect(grouped[0]?.hidden).toBe(1);
    expect(grouped[1]?.target.name).toBe('Bank');
  });

  it('a folder and a record that share an id are two groups, not one', () => {
    const grouped = groupConflicts(
      report({
        conflicts: [
          conflict({ kind: 'record-field', targetId: 'shared', field: 'title' }),
          conflict({ kind: 'folder', targetId: 'shared', field: 'name' }),
        ],
      }),
      names(),
      NO_SELECTIONS
    );
    expect(grouped).toHaveLength(2);
    expect(new Set(grouped.map((group) => group.key)).size).toBe(2);
  });

  it('the order is the engine’s own, not a rank of any kind', () => {
    // Pinned absolutely rather than only against itself. A first draft of this test compared
    // "before answering" with "after answering", which a sort keyed on anything *other* than
    // answeredness slips straight past — sorting by conflict count, for instance, reorders the
    // list on first render and never moves again. Asserting document order catches every
    // reordering, including the ones that are stable and still wrong.
    const source = report({
      conflicts: [
        conflict({ targetId: 'rec-2', field: 'title' }),
        conflict({ targetId: 'rec-1', field: 'title' }),
        conflict({ targetId: 'rec-1', field: 'username' }),
        conflict({ targetId: 'rec-3', field: 'title' }),
      ],
    });
    const keys = ['record:rec-2', 'record:rec-1', 'record:rec-3'];
    expect(groupConflicts(source, names(), NO_SELECTIONS).map((group) => group.key)).toEqual(keys);
  });

  it('the order never changes as conflicts are answered', () => {
    const source = report({
      conflicts: [
        conflict({ targetId: 'rec-1', field: 'title' }),
        conflict({ targetId: 'rec-2', field: 'title' }),
        conflict({ targetId: 'rec-3', field: 'title' }),
      ],
    });
    const before = groupConflicts(source, names(), NO_SELECTIONS).map((group) => group.key);

    // Answer the middle one — the case a "unanswered first" sort would move under the cursor.
    const answered: Selections = new Map([[source.conflicts[1]?.id ?? '', 'ours']]);
    const after = groupConflicts(source, names(), answered).map((group) => group.key);

    expect(after).toEqual(before);
    expect(after).toEqual(['record:rec-1', 'record:rec-2', 'record:rec-3']);
  });

  it('keeps a combined conflict, because the merge still did something to that record', () => {
    const grouped = groupConflicts(
      report({
        conflicts: [
          conflict({
            targetId: 'rec-1',
            field: 'attachments',
            applied: 'merged',
            resolution: 'policy',
          }),
        ],
      }),
      names(),
      NO_SELECTIONS
    );
    expect(grouped[0]?.conflicts).toHaveLength(1);
    expect(grouped[0]?.remaining).toBe(0);
  });
});

describe('filtering', () => {
  const source = report({
    conflicts: [
      conflict({ targetId: 'rec-1', field: 'title' }),
      conflict({ targetId: 'rec-2', field: 'password', ours: secret(3), theirs: secret(9) }),
    ],
  });
  const answered: Selections = new Map([[source.conflicts[0]?.id ?? '', 'ours']]);

  it('a filter drops the groups it emptied', () => {
    const groups = groupConflicts(source, names(), answered);
    const remaining = filterGroups(groups, 'remaining', answered);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.target.name).toBe('Bank');
  });

  it('shows only the hidden-value conflicts under needs-care', () => {
    const groups = groupConflicts(source, names(), NO_SELECTIONS);
    const care = filterGroups(groups, 'needs-care', NO_SELECTIONS);
    expect(care).toHaveLength(1);
    expect(care[0]?.conflicts[0]?.field).toBe('password');
  });

  it('everything is a pass-through, so it cannot lose a conflict', () => {
    const groups = groupConflicts(source, names(), answered);
    expect(filterGroups(groups, 'all', answered)).toBe(groups);
  });

  it('the chips count conflicts, because that is what the user counts', () => {
    const counts = filterCounts(source, answered);
    expect(counts.all).toBe(2);
    expect(counts.remaining).toBe(1);
    expect(counts.answered).toBe(1);
    expect(counts['needs-care']).toBe(1);
  });

  it('has a label for every filter it offers', () => {
    expect(CONFLICT_FILTERS).toHaveLength(4);
    expect(new Set(CONFLICT_FILTERS).size).toBe(4);
  });
});

describe('four hundred conflicts', () => {
  const four_hundred = bigReport(400);

  it('groups them without collapsing any of them away', () => {
    const groups = groupConflicts(four_hundred, names(), NO_SELECTIONS);
    expect(groups).toHaveLength(400);
    expect(groups.reduce((total, group) => total + group.conflicts.length, 0)).toBe(400);
  });

  it('says how many conflicts are off screen, not just how many groups', () => {
    const groups = groupConflicts(four_hundred, names(), NO_SELECTIONS);
    const page = pageOfGroups(groups, 1);
    expect(page.shown).toHaveLength(GROUP_PAGE_SIZE);
    expect(page.hiddenGroups).toBe(400 - GROUP_PAGE_SIZE);
    expect(page.hiddenConflicts).toBe(400 - GROUP_PAGE_SIZE);
  });

  it('grows the page rather than jumping to the end', () => {
    const groups = groupConflicts(four_hundred, names(), NO_SELECTIONS);
    expect(pageOfGroups(groups, 2).shown).toHaveLength(GROUP_PAGE_SIZE * 2);
    expect(pageOfGroups(groups, 100).hiddenGroups).toBe(0);
  });

  it('a long merge opens as an index, not as a wall', () => {
    const many = groupConflicts(bigReport(AUTO_EXPAND_LIMIT + 1), names(), NO_SELECTIONS);
    expect(initiallyExpanded(many).size).toBe(0);
  });

  it('a short merge opens fully, so nothing needs a click to be read', () => {
    const few = groupConflicts(bigReport(AUTO_EXPAND_LIMIT), names(), NO_SELECTIONS);
    expect(initiallyExpanded(few).size).toBe(AUTO_EXPAND_LIMIT);
  });
});
