// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { CredentialVersion } from '@shared/model/credential.js';
import { assertValidHistory } from '../history/versioning.js';
import { mergeVersions } from './merge-history.js';
import { mergeCredential, type RecordMergeContext } from './merge-record.js';
import { DAY, NOW, edited, origin, record, version } from './test-fixtures.js';

/**
 * Merging two timelines.
 *
 * This is the part of a merge most able to fail *quietly*. A wrong field value is visible the
 * moment someone looks at the record. A corrupt version array looks completely fine until the
 * day the user restores from it and gets values that existed on neither device — and by then
 * the correct ones are gone.
 *
 * So the assertions here are of two kinds, and both matter:
 *
 *   1. **The invariants hold, always.** `assertValidHistory` is run on the result of every
 *      case, not only the ones about numbering, because it is the check that stands between a
 *      merge bug and a restore that writes the wrong password.
 *   2. **The exact case is preserved, where it can be.** Two devices that share an ancestor
 *      share its whole timeline, and if only one of them edited the record, the merged chain
 *      must be *that side's, unchanged* — not a re-derived array that happens to look similar.
 *      Renumbering a timeline nobody interleaved would invalidate every version number a user
 *      has written down, for nothing.
 */

const CTX: RecordMergeContext = {
  ancestorKnown: true,
  mergeOrigin: null,
  resolutions: new Map(),
};

const v1 = version({ versionNumber: 1, savedAt: NOW - 30 * DAY, snapshot: { title: 'First' } });
const v2 = version({ versionNumber: 2, savedAt: NOW - 20 * DAY, snapshot: { title: 'Second' } });

/** The same event as `v2`, carrying the number a differently-pruned device gave it. */
const v2Renumbered: CredentialVersion = { ...v2, versionNumber: 7 };

const ourEdit = version({
  versionNumber: 3,
  savedAt: NOW - 3 * DAY,
  snapshot: { username: 'ours' },
});
const theirEdit = version({
  versionNumber: 3,
  savedAt: NOW - 2 * DAY,
  snapshot: { username: 'theirs' },
});

// ── The exact cases ──────────────────────────────────────────────────────────

describe('a timeline nobody interleaved comes back untouched', () => {
  it('returns the identical array for merge(x, x)', () => {
    const merged = mergeVersions([v1], [v1, v2], [v1, v2], null);
    expect(merged.versions).toEqual([v1, v2]);
    expect(merged.renumbered).toBe(false);
    expect(merged.dropped).toBe(0);
  });

  it('keeps the editing side’s numbering when only one side edited', () => {
    const merged = mergeVersions([v1], [v1], [v1, v2], null);
    expect(merged.versions).toEqual([v1, v2]);
    expect(merged.versions.map((entry) => entry.versionNumber)).toEqual([1, 2]);
    expect(merged.renumbered).toBe(false);
  });

  it('keeps the gaps that pruning left in the numbering', () => {
    // `pruneVersions` never renumbers, deliberately, so a real timeline's numbers have holes in
    // them. A merge that quietly closed those holes on every sync would invalidate every
    // version number a user has written down or a bug report quotes.
    const pruned = { ...v1, versionNumber: 5 };
    const later = { ...v2, versionNumber: 9 };
    const merged = mergeVersions([pruned], [pruned], [pruned, later], null);
    expect(merged.versions.map((entry) => entry.versionNumber)).toEqual([5, 9]);
    expect(merged.renumbered).toBe(false);
  });

  it('de-duplicates the shared prefix by event, not by version number', () => {
    // The same edit carries different numbers on two devices whenever one of them has been
    // renumbered by an earlier merge. Identifying by number would double the whole shared
    // history on every single sync, forever.
    const merged = mergeVersions([v1], [v1, v2], [v1, v2Renumbered], null);
    expect(merged.versions).toHaveLength(2);
  });
});

// ── The interleaved case ─────────────────────────────────────────────────────

describe('two timelines that genuinely diverged', () => {
  it('orders by savedAt and renumbers contiguously from one', () => {
    const merged = mergeVersions([v1, v2], [v1, v2, ourEdit], [v1, v2, theirEdit], null);

    expect(merged.versions.map((entry) => entry.versionNumber)).toEqual([1, 2, 3, 4]);
    expect(merged.versions.map((entry) => entry.savedAt)).toEqual([
      v1.savedAt,
      v2.savedAt,
      ourEdit.savedAt,
      theirEdit.savedAt,
    ]);
    expect(merged.renumbered).toBe(true);
  });

  it('never rewrites an entry beyond its number', () => {
    // The one violation that would let a restore write a value the timeline never displayed is
    // a snapshot acquiring a key. Renumbering must touch `versionNumber` and nothing else.
    const merged = mergeVersions([v1], [v1, ourEdit], [v1, theirEdit], null);
    for (const entry of merged.versions) {
      const source = [v1, ourEdit, theirEdit].find(
        (candidate) => candidate.savedAt === entry.savedAt
      );
      expect(entry.snapshot).toEqual(source?.snapshot);
      expect(entry.changedFields).toEqual(source?.changedFields);
      expect(entry.origin).toEqual(source?.origin);
    }
  });

  it('orders identically whichever document was passed first', () => {
    const forwards = mergeVersions([v1], [v1, ourEdit], [v1, theirEdit], null);
    const backwards = mergeVersions([v1], [v1, theirEdit], [v1, ourEdit], null);
    expect(forwards.versions).toEqual(backwards.versions);
  });

  it('breaks a same-millisecond tie deterministically, in both directions', () => {
    const sameInstantOurs = version({
      versionNumber: 2,
      savedAt: NOW - DAY,
      snapshot: { title: 'A' },
    });
    const sameInstantTheirs = version({
      versionNumber: 2,
      savedAt: NOW - DAY,
      snapshot: { title: 'B' },
    });

    const forwards = mergeVersions([v1], [v1, sameInstantOurs], [v1, sameInstantTheirs], null);
    const backwards = mergeVersions([v1], [v1, sameInstantTheirs], [v1, sameInstantOurs], null);
    expect(forwards.versions.map((entry) => entry.snapshot)).toEqual(
      backwards.versions.map((entry) => entry.snapshot)
    );
  });
});

// ── Deletion ─────────────────────────────────────────────────────────────────

describe('a version deleted on one side stays deleted', () => {
  it('honours "Clear history" rather than putting the old passwords back', () => {
    // The privacy motive is the whole point: a union would restore every entry a user just
    // deliberately destroyed, on the next sync, with no message anywhere.
    const merged = mergeVersions([v1, v2], [v1, v2], [], null);
    expect(merged.versions).toEqual([]);
  });

  it('unions instead when there is no ancestor, because absence proves nothing', () => {
    const merged = mergeVersions(null, [v1], [v2], null);
    expect(merged.versions).toHaveLength(2);
  });
});

// ── Retention ────────────────────────────────────────────────────────────────

describe('the retention cap applies to the combined timeline', () => {
  it('drops the oldest and reports how many', () => {
    const merged = mergeVersions([v1, v2], [v1, v2, ourEdit], [v1, v2, theirEdit], 2);
    expect(merged.versions.map((entry) => entry.snapshot)).toEqual([
      ourEdit.snapshot,
      theirEdit.snapshot,
    ]);
    expect(merged.dropped).toBe(2);
  });

  it('keeps nothing at a cap of zero, which is not the same as history being off', () => {
    expect(mergeVersions([v1], [v1, v2], [v1, ourEdit], 0).versions).toEqual([]);
  });
});

// ── The invariants, through the record merge ─────────────────────────────────

describe('a merged record always satisfies assertValidHistory', () => {
  const base = record({ id: 'a', title: 'First', versions: [v1, v2] });

  it('after two timelines were interleaved and renumbered', () => {
    const merged = mergeCredential(
      base,
      edited(base, { title: 'Ours', versions: [v1, v2, ourEdit] }),
      edited(base, { username: 'theirs', versions: [v1, v2, theirEdit] }),
      CTX
    );
    assertValidHistory(merged.credential);
    expect(merged.credential.history.versions.map((entry) => entry.versionNumber)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(merged.notes.map((note) => note.kind)).toContain('history-renumbered');
  });

  it('after the cap truncated the combined timeline, and says how many went', () => {
    const capped = record({ id: 'a', title: 'First', historyMaxVersions: 2, versions: [v1, v2] });
    const merged = mergeCredential(
      capped,
      edited(capped, { title: 'Ours', versions: [v1, v2, ourEdit] }),
      edited(capped, { username: 'theirs', versions: [v1, v2, theirEdit] }),
      CTX
    );
    assertValidHistory(merged.credential);
    expect(merged.credential.history.versions).toHaveLength(2);
    const truncated = merged.notes.find((note) => note.kind === 'history-truncated');
    expect(truncated?.count).toBe(2);
  });

  it('after the merge appended its own version on top of a renumbered chain', () => {
    // The worst ordering: interleave two chains, renumber them, then append. If the append
    // read a stale "last version number" the array would stop ascending, and the only place
    // that shows up is a restore picking the wrong entry.
    const merged = mergeCredential(
      base,
      edited(base, { title: 'Ours', versions: [v1, v2, ourEdit] }),
      edited(base, { username: 'theirs', versions: [v1, v2, theirEdit] }),
      { ...CTX, mergeOrigin: origin('merge', 'laptop') }
    );
    assertValidHistory(merged.credential);

    const numbers = merged.credential.history.versions.map((entry) => entry.versionNumber);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(merged.credential.history.versions.at(-1)?.origin.action).toBe('merge');
  });

  it('and every snapshot key is still listed as changed', () => {
    const merged = mergeCredential(
      base,
      edited(base, { title: 'Ours', versions: [v1, v2, ourEdit] }),
      edited(base, { username: 'theirs', versions: [v1, v2, theirEdit] }),
      { ...CTX, mergeOrigin: origin('merge') }
    );
    for (const entry of merged.credential.history.versions) {
      for (const key of Object.keys(entry.snapshot)) {
        expect(entry.changedFields).toContain(key);
      }
    }
  });
});
