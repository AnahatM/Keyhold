// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Structural equality and a canonical serialisation, for a merge engine that must be
 * deterministic in both directions.
 *
 * `versioning.ts` compares values with `JSON.stringify`, which is right for its purpose: it
 * compares two values that came out of the *same* record, so key order is necessarily the
 * same on both sides. A merge compares values that came out of **two different files**,
 * written by two different builds, possibly round-tripped through an import parser that built
 * its objects in a different order. `{a:1,b:2}` and `{b:2,a:1}` are the same custom field and
 * `JSON.stringify` says they are not — which would report a conflict on a field nobody
 * touched, and ask the user to choose between two identical values.
 *
 * So keys are sorted. That is the entire difference, and it is load-bearing.
 *
 * ## The serialised form is derived from secret material and must never leave this process
 *
 * `canonical()` is called on passwords, notes, security answers and custom values, because
 * those are exactly the fields a merge has to compare. Its output therefore *contains*
 * secrets. It is used for equality, for de-duplicating history entries and for deterministic
 * tie-breaking — all of which stay inside the merge — and it must never reach a log, an
 * error message, a report, or IPC. Nothing in `src/shared/model/sync.ts` has a field that
 * could hold one, which is the structural half of that guarantee.
 */

/**
 * A canonical JSON encoding: object keys sorted, arrays in order, `undefined` as `null`.
 *
 * **Contains secret material when given a credential field.** See the file header.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalise);

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  // Sorting the keys is the whole point of this function; see the file header.
  for (const key of Object.keys(source).sort()) sorted[key] = normalise(source[key]);
  return sorted;
}

/** Deep structural equality, insensitive to key order. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return canonical(a) === canonical(b);
}

/**
 * A total order over any two values, used only for tie-breaking.
 *
 * Where two candidates are equally valid and the choice must not depend on which document
 * was passed first, the engine picks the canonically smaller one. Arbitrary, but *stable* and
 * *commutative*, which is what the property tests need and what a user re-running a merge
 * needs. It is never used to choose between two credential values — those become conflicts.
 */
export function canonicallyFirst<T>(a: T, b: T): T {
  return canonical(a) <= canonical(b) ? a : b;
}

/** `Math.max` that treats `null` as "unset", not as zero. */
export function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** `Math.min` that treats `null` as "unset", not as zero. */
export function minNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * The larger of two caps, where `null` means "unlimited" and therefore wins.
 *
 * Distinct from `maxNullable`, where `null` means "absent". Two settings in this codebase use
 * `null` for unlimited — `historyMaxVersions` and `trashRetentionDays` — and reading one of
 * them as "absent" would silently pick the *smaller* cap, which is the direction that loses
 * data. Two functions rather than a flag, so the call site says which meaning it intends.
 */
export function largerCap(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return Math.max(a, b);
}
