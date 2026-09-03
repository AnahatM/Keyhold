// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { orderIds } from './merge-values.js';

/**
 * `orderIds` on its own, because it is the one function in the engine that decides which ids
 * reach the output and is not obviously about survival.
 *
 * It reads as presentation — "in what order do these appear?" — and it is not. Every caller
 * builds its result by mapping the list this returns back through a surviving-entries index
 * (`merge-values.ts:165-169`, `merge-collections.ts:156-160`, `merge-document.ts:175-177`), so
 * an id this omits is an entry that never reaches the merged document, and an id it repeats is
 * an entry emitted twice. That makes its contract a data-safety contract:
 *
 *   **`orderIds` returns exactly the surviving set, each id exactly once.**
 *
 * The tests below are that sentence, case by case. The first one is the regression: with a
 * duplicate id on one side, the old `sameIdSet` answered "this list is the surviving set" for
 * `['a', 'a']` against `{a, b}` — two entries, two survivors, every entry present — and the
 * merge returned record `a` twice and dropped record `b` on the floor. Hard rule 6.
 */

/** The contract, as an assertion, so every case below states it the same way. */
function expectExactlyOnce(order: readonly string[], surviving: ReadonlySet<string>): void {
  expect([...order].sort()).toEqual([...surviving].sort());
  expect(new Set(order).size).toBe(order.length);
}

describe('orderIds never drops or repeats a surviving id', () => {
  it('keeps the id a duplicate on our side would displace', () => {
    // The exact input from the audit's N3: our list holds `a` twice, and `b` survived from
    // the other side. Two ids in, two survivors — the counts match while the sets do not.
    const surviving = new Set(['a', 'b']);
    const order = orderIds(surviving, ['a', 'a'], ['b'], null);

    expect(order).toContain('b');
    expectExactlyOnce(order, surviving);
  });

  it('keeps it when the duplicate is on their side', () => {
    const surviving = new Set(['a', 'b']);
    const order = orderIds(surviving, ['a'], ['b', 'b'], null);

    expect(order).toContain('a');
    expectExactlyOnce(order, surviving);
  });

  it('keeps it when both sides are duplicate-laden', () => {
    const surviving = new Set(['a', 'b', 'c']);
    const order = orderIds(surviving, ['a', 'a', 'b'], ['c', 'c', 'b'], null);
    expectExactlyOnce(order, surviving);
  });

  it('does not repeat an id when the duplicate is the only survivor', () => {
    const surviving = new Set(['a']);
    expectExactlyOnce(orderIds(surviving, ['a', 'a'], ['a', 'a'], null), surviving);
  });

  it('still respects the ancestor order when a side holds a duplicate', () => {
    // Falling out of the "one side's order" branch must land in the combined branch, which is
    // ancestor-first — not in some third behaviour.
    const surviving = new Set(['a', 'b', 'c']);
    const order = orderIds(surviving, ['c', 'c', 'a'], ['b'], ['c', 'b', 'a']);
    expect(order).toEqual(['c', 'b', 'a']);
  });
});

describe('the boundaries', () => {
  it('returns nothing when nothing survived', () => {
    expect(orderIds(new Set(), [], [], null)).toEqual([]);
    expect(orderIds(new Set(), ['a', 'b'], ['c'], ['a'])).toEqual([]);
  });

  it('returns the one id when one survived', () => {
    expect(orderIds(new Set(['a']), ['a'], [], null)).toEqual(['a']);
    expect(orderIds(new Set(['a']), [], [], null)).toEqual(['a']);
  });

  it('keeps our order when the surviving set is exactly ours, however it is spelled', () => {
    // The same multiset in a different order is still the same set, and the whole point of
    // the "nothing was combined" branch is that an untouched list comes back untouched. A
    // fix that tightened this into a *sequence* comparison would reshuffle lists nobody
    // edited, which is the bug `merge(x, x) === x` exists to catch.
    const surviving = new Set(['a', 'b', 'c']);
    expect(orderIds(surviving, ['c', 'a', 'b'], ['c', 'a', 'b'], null)).toEqual(['c', 'a', 'b']);
    expect(orderIds(surviving, ['b', 'c', 'a'], ['x'], null)).toEqual(['b', 'c', 'a']);
  });

  it('does not treat a strict superset as the surviving set', () => {
    // `['a','b','c']` contains every survivor and then some. Keeping that side's order would
    // be right; keeping that side's *contents* would resurrect `c`, which the merge decided
    // was gone. `keep()` filters, so this is safe either way — the case is locked because it
    // is one line of drift away from not being.
    const surviving = new Set(['a', 'b']);
    expectExactlyOnce(orderIds(surviving, ['a', 'b', 'c'], ['b', 'a'], null), surviving);
  });

  it('gives the same answer whichever side is passed first', () => {
    // Commutativity, which is what the canonical tie-break in the both-sides branch is for.
    const surviving = new Set(['a', 'b']);
    const ours = ['b', 'a'];
    const theirs = ['a', 'b'];
    expect(orderIds(surviving, ours, theirs, null)).toEqual(
      orderIds(surviving, theirs, ours, null)
    );

    const duplicated = new Set(['a', 'b', 'c']);
    expect(orderIds(duplicated, ['a', 'a', 'b'], ['c'], null)).toEqual(
      orderIds(duplicated, ['c'], ['a', 'a', 'b'], null)
    );
  });

  it('sorts the ids no side accounted for, after the ancestor order', () => {
    const surviving = new Set(['a', 'b', 'c', 'd']);
    expect(orderIds(surviving, ['c'], ['d', 'a'], ['c', 'b'])).toEqual(['c', 'b', 'a', 'd']);
  });
});
