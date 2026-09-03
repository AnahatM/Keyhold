// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DEFAULT_SORT_DIRECTION, SORT_KEYS } from '@shared/search/sort.js';
import { SORT_LABELS, directionLabel, offeredSortKeys } from './sort-labels.js';

/**
 * The words on the sort control.
 *
 * Worth testing because the failure is silent in both directions. A key added to the engine
 * with no label here is an option that never appears — the `Record` makes that a compile error
 * rather than a runtime absence, and the first test below is what would notice if the type ever
 * loosened. A *duplicate* label is worse: two options reading "Date" in one menu, where the only
 * way to tell them apart is to pick one and watch the list.
 *
 * Fault injection performed:
 *  1. Giving `createdAt` and `updatedAt` the same `label` — fails "no two keys read the same".
 *  2. Returning `SORT_KEYS` unfiltered from `offeredSortKeys` — fails "relevance is offered only
 *     with a query behind it".
 *  3. Swapping the `asc`/`desc` strings for `useCount` — fails "ascending means less of the
 *     thing, in whatever words that key uses".
 */

describe('every key is named', () => {
  it('has a label for each key the engine sorts by', () => {
    for (const key of SORT_KEYS) {
      expect(SORT_LABELS[key].label, key).toBeTruthy();
      expect(SORT_LABELS[key].asc, key).toBeTruthy();
      expect(SORT_LABELS[key].desc, key).toBeTruthy();
    }
    expect(Object.keys(SORT_LABELS)).toHaveLength(SORT_KEYS.length);
  });

  it('no two keys read the same, in the list or in a direction', () => {
    // Two options reading "Date" in one menu can only be told apart by picking one.
    const labels = SORT_KEYS.map((key) => SORT_LABELS[key].label);
    expect(new Set(labels).size).toBe(labels.length);

    for (const key of SORT_KEYS) {
      expect(SORT_LABELS[key].asc, key).not.toBe(SORT_LABELS[key].desc);
    }
  });

  it('says what the direction means rather than which way it points', () => {
    // "Ascending" is accurate and useless — nobody thinks of their passwords as ascending.
    for (const key of SORT_KEYS) {
      const both = `${SORT_LABELS[key].asc} ${SORT_LABELS[key].desc}`.toLowerCase();
      expect(both, key).not.toContain('ascending');
      expect(both, key).not.toContain('descending');
    }
  });

  it('ascending means less of the thing, in whatever words that key uses', () => {
    // The trap this guards: for a date, ascending is *oldest*; for a count it is *fewest*. A
    // control that says "newest first" while sorting ascending is lying about what it did.
    expect(directionLabel('useCount', 'asc')).toContain('Least');
    expect(directionLabel('useCount', 'desc')).toContain('Most');
    expect(directionLabel('createdAt', 'asc')).toContain('Oldest');
    expect(directionLabel('createdAt', 'desc')).toContain('Newest');
  });
});

describe('which keys are offered', () => {
  it('relevance is offered only with a query behind it', () => {
    // On an empty box every record scores the same and the order reads as random.
    expect(offeredSortKeys(false)).not.toContain('relevance');
    expect(offeredSortKeys(true)).toContain('relevance');
  });

  it('everything else is always offered', () => {
    const withoutQuery = offeredSortKeys(false);
    for (const key of SORT_KEYS) {
      if (key !== 'relevance') expect(withoutQuery, key).toContain(key);
    }
  });

  it('every offered key has a default direction to open on', () => {
    for (const key of offeredSortKeys(true)) {
      expect(DEFAULT_SORT_DIRECTION[key], key).toBeTruthy();
    }
  });
});
