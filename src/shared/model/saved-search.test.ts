// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  bySavedSearchOrder,
  normaliseSavedSearch,
  savedSearchProblem,
  SAVED_SEARCH_NAME_MAX,
  SAVED_SEARCH_QUERY_MAX,
  type SavedSearch,
} from './saved-search.js';

/**
 * The saved-search model.
 *
 * Worth testing because this is the boundary two very different callers share: the settings
 * UI validating something a person just typed, and the document parser deciding whether an
 * entry that arrived **from a file anyone can write** is usable. A rule that held in one and
 * not the other would mean a `.keep` could carry a saved search the UI would refuse to
 * create — which is the shape of every "how did that get in there" bug.
 */

function search(overrides: Partial<SavedSearch> = {}): SavedSearch {
  return {
    id: 'search-1',
    name: 'Banking',
    query: 'folder:Finance has:totp',
    order: 0,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('validation', () => {
  it('accepts a well-formed saved search', () => {
    expect(savedSearchProblem(search())).toBeNull();
  });

  it.each([
    ['not an object', 42],
    ['an array', []],
    ['null', null],
  ])('refuses %s', (_label, value) => {
    expect(savedSearchProblem(value)).not.toBeNull();
  });

  it('refuses one with no id', () => {
    expect(savedSearchProblem(search({ id: '' }))).toBe('it has no id');
  });

  it('refuses a name that is only whitespace', () => {
    // Trimmed before measuring, so a name of three spaces is empty rather than three
    // characters long. The alternative is a sidebar row with no visible label at all.
    expect(savedSearchProblem(search({ name: '   ' }))).toBe('its name is empty');
  });

  it('refuses a name past the cap', () => {
    const problem = savedSearchProblem(search({ name: 'x'.repeat(SAVED_SEARCH_NAME_MAX + 1) }));
    expect(problem).toContain(String(SAVED_SEARCH_NAME_MAX));
  });

  it('refuses an empty query rather than treating it as "everything"', () => {
    // A saved search matching every record is indistinguishable from the "All items" row that
    // already exists, and a user who saved one by accident would have no way to work out why
    // clicking it appears to do nothing.
    expect(savedSearchProblem(search({ query: '   ' }))).toBe('its query is empty');
  });

  it('refuses a query past the cap', () => {
    const problem = savedSearchProblem(search({ query: 'x'.repeat(SAVED_SEARCH_QUERY_MAX + 1) }));
    expect(problem).toContain(String(SAVED_SEARCH_QUERY_MAX));
  });

  it.each([
    ['order', { order: Number.NaN }],
    ['updatedAt', { updatedAt: Number.POSITIVE_INFINITY }],
  ])('refuses a non-finite %s', (_label, overrides) => {
    // `Number.isFinite`, not `typeof === 'number'`: `NaN` and `Infinity` are both numbers, and
    // either one in `order` makes `bySavedSearchOrder` return `NaN` and the sort order
    // undefined — a list that reshuffles itself on every render.
    expect(savedSearchProblem(search(overrides))).not.toBeNull();
  });

  it('never quotes the value it is complaining about', () => {
    // The reason ends up in an error banner, and a query can carry a fragment of a record's
    // title. Nothing about the offending text may appear in the message.
    const secretish = 'my-offshore-account-at-example-bank';
    const problem = savedSearchProblem(search({ name: '', query: secretish }));
    expect(problem).not.toBeNull();
    expect(problem).not.toContain(secretish);
  });
});

describe('normalisation', () => {
  it('trims the name but not the query', () => {
    // Leading whitespace in a name is a typo. In a query it is the parser's business, and
    // quietly editing what the user typed before parsing it would make the diagnostics point
    // at text they never wrote.
    const result = normaliseSavedSearch(search({ name: '  Banking  ', query: '  is:weak  ' }));
    expect(result.name).toBe('Banking');
    expect(result.query).toBe('  is:weak  ');
  });

  it('clamps both to their caps', () => {
    const result = normaliseSavedSearch(
      search({ name: 'n'.repeat(200), query: 'q'.repeat(1_000) })
    );
    expect(result.name).toHaveLength(SAVED_SEARCH_NAME_MAX);
    expect(result.query).toHaveLength(SAVED_SEARCH_QUERY_MAX);
  });

  it('produces something the validator accepts, from something it did not', () => {
    // The property that makes it safe to normalise-then-validate on the way in from a file:
    // an over-long name is repaired rather than rejected, so one long label does not cost the
    // user every other saved search in the vault.
    const tooLong = search({ name: 'n'.repeat(200) });
    expect(savedSearchProblem(tooLong)).not.toBeNull();
    expect(savedSearchProblem(normaliseSavedSearch(tooLong))).toBeNull();
  });

  it('keeps the id, order and timestamp exactly', () => {
    const original = search({ id: 'abc', order: 7, updatedAt: 123 });
    const result = normaliseSavedSearch(original);
    expect(result.id).toBe('abc');
    expect(result.order).toBe(7);
    expect(result.updatedAt).toBe(123);
  });
});

describe('ordering', () => {
  it('sorts by stored position', () => {
    const list = [search({ id: 'b', order: 2 }), search({ id: 'a', order: 1 })];
    expect([...list].sort(bySavedSearchOrder).map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('falls back to the name when two share a position', () => {
    // Two entries at the same `order` is a normal outcome of merging two machines' lists, and
    // an unstable order there would make the sidebar reshuffle after every sync.
    const list = [
      search({ id: 'z', name: 'Zebra', order: 0 }),
      search({ id: 'a', name: 'Apple', order: 0 }),
    ];
    expect([...list].sort(bySavedSearchOrder).map((entry) => entry.name)).toEqual([
      'Apple',
      'Zebra',
    ]);
  });
});
