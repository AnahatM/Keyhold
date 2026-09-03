// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { CredentialProjection, VersionProjection } from '@shared/model/credential.js';
import { defaultComparison, historyPointsFor, isComparablePair } from './history-points.js';

/**
 * Which two states a comparison can be drawn between.
 *
 * The diff engine behind this is already tested; what is asserted here is the offer. A list of
 * points that omits the current state makes the common question — "what has changed since
 * March" — unaskable, and a list whose labels collide makes it unanswerable, because several
 * edits in one minute is ordinary and three options reading "3 Sep, 14:02" cannot be chosen
 * between.
 *
 * Fault injection performed:
 *  1. Dropping the `current` entry from `historyPointsFor` — fails "offers the current state,
 *     which is one half of nearly every comparison".
 *  2. Labelling by date alone — fails "labels are distinct even when two versions share a
 *     minute".
 *  3. Returning `true` unconditionally from `isComparablePair` — fails "a point is not
 *     comparable with itself".
 *  4. Sorting versions oldest-first — fails "newest first, with the current state leading".
 */

const version = (versionNumber: number, savedAt: number): VersionProjection => ({
  versionNumber,
  savedAt,
  changedFields: ['password'],
  snapshot: {},
  secretFields: [],
  origin: { action: 'update' },
});

const credential = (
  versions: readonly VersionProjection[],
  updatedAt = 5_000
): CredentialProjection =>
  ({
    id: 'rec-1',
    history: versions,
    meta: { updatedAt },
  }) as unknown as CredentialProjection;

describe('the points on offer', () => {
  it('offers the current state, which is one half of nearly every comparison', () => {
    const points = historyPointsFor(credential([version(1, 1_000)]));
    expect(points.some((point) => point.ref === 'current')).toBe(true);
  });

  it('newest first, with the current state leading', () => {
    const points = historyPointsFor(
      credential([version(1, 1_000), version(3, 3_000), version(2, 2_000)])
    );
    expect(points.map((point) => point.ref)).toEqual(['current', 3, 2, 1]);
  });

  it('labels are distinct even when two versions share a minute', () => {
    // Three edits inside the same minute is ordinary — a paste, a correction, a save — and a
    // list of three identically-dated options is one nobody can pick from.
    const sameMinute = 1_700_000_000_000;
    const points = historyPointsFor(
      credential([version(1, sameMinute), version(2, sameMinute), version(3, sameMinute)])
    );
    const labels = points.map((point) => point.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('a record with no history offers only the current state', () => {
    expect(historyPointsFor(credential([])).map((point) => point.ref)).toEqual(['current']);
  });
});

describe('which pairs mean something', () => {
  it('a point is not comparable with itself', () => {
    expect(isComparablePair('current', 'current')).toBe(false);
    expect(isComparablePair(2, 2)).toBe(false);
  });

  it('either direction is allowed, because they are different questions', () => {
    // "What did I lose" and "what did I gain" are both real, and the engine diffs correctly
    // either way round.
    expect(isComparablePair(2, 'current')).toBe(true);
    expect(isComparablePair('current', 2)).toBe(true);
  });
});

describe('what it opens with', () => {
  it('the newest version against the current state', () => {
    // The question already on screen in the timeline, so the panel starts by agreeing with it
    // rather than showing something that has to be re-read to understand.
    const points = historyPointsFor(credential([version(1, 1_000), version(2, 2_000)]));
    expect(defaultComparison(points)).toEqual({ from: 2, to: 'current' });
  });

  it('is nothing at all when there is only one point', () => {
    const points = historyPointsFor(credential([]));
    expect(defaultComparison(points)).toBeNull();
  });

  it('always opens on a pair that is actually comparable', () => {
    for (const count of [0, 1, 2, 5]) {
      const versions = Array.from({ length: count }, (_unused, index) =>
        version(index + 1, 1_000 * (index + 1))
      );
      const opening = defaultComparison(historyPointsFor(credential(versions)));
      if (opening !== null) expect(isComparablePair(opening.from, opening.to)).toBe(true);
    }
  });
});
