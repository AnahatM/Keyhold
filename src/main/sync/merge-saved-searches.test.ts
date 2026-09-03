// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SAVED_SEARCH_MAX } from '@shared/model/saved-search.js';
import { mergeDocuments } from './merge-document.js';
import { doc, savedSearch, NOW } from './test-fixtures.js';

/**
 * Saved searches through the merge.
 *
 * A new field on `VaultDocument` that the merge does not know about is a field that silently
 * vanishes the first time two machines sync — the merged document is rebuilt from parts, so
 * anything unclaimed is simply not carried. That failure is invisible until somebody notices
 * their shortcuts are gone and cannot say when, which is why this file exists at all.
 */

const OPTIONS = { now: NOW } as const;

function merge(
  base: ReturnType<typeof doc> | null,
  ours: ReturnType<typeof doc>,
  theirs: ReturnType<typeof doc>
) {
  return mergeDocuments(base, ours, theirs, OPTIONS);
}

describe('merging saved searches', () => {
  it('carries them through a merge at all', () => {
    const ours = doc({ savedSearches: [savedSearch('a')] });
    const outcome = merge(null, ours, doc());

    expect(outcome.document.savedSearches.map((entry) => entry.id)).toEqual(['a']);
  });

  it('brings in one that exists only on the other side', () => {
    const outcome = merge(
      null,
      doc({ savedSearches: [savedSearch('a')] }),
      doc({ savedSearches: [savedSearch('b', { order: 1 })] })
    );

    expect(outcome.document.savedSearches.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(outcome.report.notes.some((note) => note.kind === 'saved-search-added')).toBe(true);
  });

  it('honours a deletion the other side made, when we did not touch it', () => {
    const base = doc({ savedSearches: [savedSearch('a')] });
    const outcome = merge(base, base, doc({ savedSearches: [] }));

    // Exactly what folders and tags do. With an ancestor, "present in the ancestor, gone on
    // one side, untouched on the other" is a deletion and is honoured — deleting a shortcut
    // on one machine has to actually delete it, or the delete button does nothing that
    // survives a sync.
    expect(outcome.document.savedSearches).toEqual([]);
  });

  it('keeps one that was deleted there and edited here', () => {
    const base = doc({ savedSearches: [savedSearch('a', { name: 'Old' })] });
    const ours = doc({
      savedSearches: [savedSearch('a', { name: 'Renamed', updatedAt: NOW + 1 })],
    });
    const outcome = merge(base, ours, doc({ savedSearches: [] }));

    // Deleted on one side, edited on the other: the edit wins. Somebody was still using it,
    // and a shortcut is trivially deleted again — whereas an edit deleted out from under its
    // author is work they have to notice before they can redo it.
    expect(outcome.document.savedSearches.map((entry) => entry.id)).toEqual(['a']);
    expect(outcome.report.notes.some((note) => note.kind === 'saved-search-kept-unmatched')).toBe(
      true
    );
  });

  it('unions both sides when there is no ancestor to judge against', () => {
    // A two-way merge has no evidence that anything was deleted — only that one file does not
    // have it. Deleting on the strength of that would be deleting on the evidence of nothing.
    const outcome = merge(null, doc({ savedSearches: [savedSearch('a')] }), doc());
    expect(outcome.document.savedSearches.map((entry) => entry.id)).toEqual(['a']);
  });

  it('takes the later edit whole, never half of each', () => {
    const base = doc({ savedSearches: [savedSearch('a', { name: 'Old', query: 'is:weak' })] });
    const ours = doc({
      savedSearches: [savedSearch('a', { name: 'Mine', query: 'is:weak', updatedAt: NOW })],
    });
    const theirs = doc({
      savedSearches: [
        savedSearch('a', { name: 'Theirs', query: 'is:reused', updatedAt: NOW + 1_000 }),
      ],
    });

    const [merged] = merge(base, ours, theirs).document.savedSearches;
    // The property that matters. Resolving name and query independently could produce
    // "Mine" pointing at `is:reused` — a shortcut labelled one thing that searches for
    // another, which is worse than either side's version.
    expect(merged?.name).toBe('Theirs');
    expect(merged?.query).toBe('is:reused');
  });

  it('keeps ours when ours is the later edit', () => {
    const base = doc({ savedSearches: [savedSearch('a', { name: 'Old' })] });
    const ours = doc({
      savedSearches: [savedSearch('a', { name: 'Mine', updatedAt: NOW + 5_000 })],
    });
    const theirs = doc({ savedSearches: [savedSearch('a', { name: 'Theirs', updatedAt: NOW })] });

    expect(merge(base, ours, theirs).document.savedSearches[0]?.name).toBe('Mine');
  });

  it('raises no conflict for the user to resolve', () => {
    const base = doc({ savedSearches: [savedSearch('a', { name: 'Old' })] });
    const ours = doc({ savedSearches: [savedSearch('a', { name: 'Mine', updatedAt: NOW + 1 })] });
    const theirs = doc({ savedSearches: [savedSearch('a', { name: 'Theirs', updatedAt: NOW })] });

    // Deliberately unlike a folder or a record. Asking somebody to adjudicate two names for a
    // bookmark, in the middle of a merge that may also be asking about real credentials,
    // spends their attention on the cheapest thing in the file.
    expect(merge(base, ours, theirs).report.conflicts).toEqual([]);
  });

  it('caps the combined list, since two legal lists can exceed the cap together', () => {
    const half = Math.ceil(SAVED_SEARCH_MAX * 0.75);
    const ours = doc({
      savedSearches: Array.from({ length: half }, (_u, i) =>
        savedSearch(`o${String(i)}`, { order: i })
      ),
    });
    const theirs = doc({
      savedSearches: Array.from({ length: half }, (_u, i) =>
        savedSearch(`t${String(i)}`, { order: half + i })
      ),
    });

    expect(merge(null, ours, theirs).document.savedSearches).toHaveLength(SAVED_SEARCH_MAX);
  });

  it('returns an untouched list untouched, so merge(x, x) is x', () => {
    const searches = [savedSearch('a'), savedSearch('b', { order: 1 })];
    const same = doc({ savedSearches: searches });

    expect(merge(same, same, same).document.savedSearches.map((entry) => entry.id)).toEqual([
      'a',
      'b',
    ]);
  });
});
