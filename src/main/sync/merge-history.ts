// SPDX-License-Identifier: GPL-3.0-or-later
import type { CredentialVersion } from '@shared/model/credential.js';
import { pruneVersions } from '../history/versioning.js';
import { canonical } from './stable-value.js';

/**
 * Merging two timelines.
 *
 * This is where a naive merge corrupts a record, so the reasoning is worth reading before the
 * code.
 *
 * ## Why a version array cannot simply be concatenated
 *
 * A version is a **backward delta**: it stores the values the record held *before* the change
 * it describes, and a state is reconstructed by starting at the live record and walking back.
 * See `CredentialVersion` for why that direction was chosen. The consequence for a merge is
 * that a version is only meaningful **relative to the lineage it belongs to**. Two devices
 * that both edited a record have two chains, each anchored at its own present. Interleaving
 * them and walking back produces a state that existed on neither device.
 *
 * So what is honest?
 *
 * **The common case is exact.** Two devices sharing an ancestor share the whole of its
 * timeline. De-duplicating by content collapses that shared prefix perfectly, and if only one
 * side edited the record, the merged chain is *identical to that side's* — the reconstruction
 * is exact, not approximate. That is the overwhelming majority of real merges: two devices
 * rarely edit the same record between syncs.
 *
 * **The lossy case is exactly the case the user is already being told about.** When both sides
 * edited the same record, the field merge produces a conflict, the merge is recorded as its
 * own version, and intermediate reconstructions from before the merge point become
 * approximate. Approximate history for a record whose conflict you are actively resolving is
 * a far smaller cost than the alternative, which is throwing away one device's audit trail —
 * in an app whose headline feature is the audit trail.
 *
 * ## What is preserved unconditionally
 *
 * Every invariant `assertValidHistory` checks: strictly ascending integer version numbers,
 * `changedFields` drawn from `VERSIONED_FIELDS`, `snapshot` keys a subset of `changedFields`,
 * and the retention cap. The entries themselves are never rewritten — only re-ordered,
 * re-numbered and pruned — so a snapshot cannot acquire a key it did not have, which is the
 * one violation that would let a restore write a value the timeline never showed.
 */

/** What the merge did to a timeline, so the report can say so. */
export interface HistoryMerge {
  readonly versions: readonly CredentialVersion[];
  /** True when two timelines were genuinely interleaved and numbers had to be reassigned. */
  readonly renumbered: boolean;
  /** Versions dropped by the retention cap after combining. */
  readonly dropped: number;
}

/**
 * The identity of a version as an *event*, deliberately excluding `versionNumber`.
 *
 * The same edit can carry different numbers on the two devices — pruning shifts nothing, but
 * an earlier merge renumbers — so identifying by number would fail to de-duplicate the shared
 * prefix and would double every entry in the timeline on every sync.
 *
 * **The result contains secret material**, because a snapshot does. It is a map key inside
 * this module and nothing else. See the header of `stable-value.ts`.
 */
function identityOf(version: CredentialVersion): string {
  return canonical({
    savedAt: version.savedAt,
    changedFields: version.changedFields,
    snapshot: version.snapshot,
    origin: version.origin,
  });
}

interface Entry {
  readonly version: CredentialVersion;
  readonly identity: string;
  /**
   * The earliest position this event held in either source array.
   *
   * The tie-breaker for two versions saved in the same millisecond, which is possible when a
   * script or an import writes twice inside one tick. Within one device, positions ascend
   * with time, so this preserves the real order; `Math.min` across the two sides keeps it
   * independent of which document was passed first.
   */
  readonly rank: number;
}

function positions(versions: readonly CredentialVersion[]): Map<string, number> {
  const index = new Map<string, number>();
  versions.forEach((version, position) => {
    const identity = identityOf(version);
    if (!index.has(identity)) index.set(identity, position);
  });
  return index;
}

/**
 * Combines two version arrays.
 *
 * `base` is used for one thing, and it is not ordering: **a version present in the ancestor
 * and absent from a side was deleted there.** That covers "Clear history", which is a real
 * user action with a privacy motive behind it — a union would quietly put every old password
 * the user just deleted straight back. It also covers ordinary retention pruning, which is
 * the same operation with a different trigger.
 *
 * With no ancestor there is no way to tell a deletion from an entry the other side never saw,
 * so the result is the union. That is the two-way trade everywhere in this engine: keep the
 * data, and say in the report that you did.
 */
export function mergeVersions(
  base: readonly CredentialVersion[] | null,
  ours: readonly CredentialVersion[],
  theirs: readonly CredentialVersion[],
  maxVersions: number | null
): HistoryMerge {
  const ourPositions = positions(ours);
  const theirPositions = positions(theirs);
  const baseIdentities = base === null ? null : new Set(base.map((version) => identityOf(version)));

  const entries = new Map<string, Entry>();
  for (const version of [...ours, ...theirs]) {
    const identity = identityOf(version);
    if (entries.has(identity)) continue;

    const inOurs = ourPositions.has(identity);
    const inTheirs = theirPositions.has(identity);
    // Deleted on the side that lacks it — either cleared or pruned. Honour the deletion.
    if (baseIdentities?.has(identity) === true && !(inOurs && inTheirs)) continue;

    entries.set(identity, {
      version,
      identity,
      rank: Math.min(
        ourPositions.get(identity) ?? Infinity,
        theirPositions.get(identity) ?? Infinity
      ),
    });
  }

  const combined = [...entries.values()].sort(compareEntries);
  const sequence = combined.map((entry) => entry.identity);

  // Nothing was actually interleaved: the result is one side's timeline unchanged, so its
  // version numbers are left alone. Renumbering here would break `merge(x, x) === x` and
  // would invalidate every "version 12" a user has written down, for no gain.
  const untouched = matchesSequence(sequence, ours) ?? matchesSequence(sequence, theirs);
  const versions =
    untouched ?? combined.map((entry, index) => ({ ...entry.version, versionNumber: index + 1 }));

  const kept = pruneVersions(versions, maxVersions);
  return {
    versions: kept,
    renumbered: untouched === null,
    dropped: versions.length - kept.length,
  };
}

function compareEntries(a: Entry, b: Entry): number {
  if (a.version.savedAt !== b.version.savedAt) return a.version.savedAt - b.version.savedAt;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
}

/** The side's own array, if the combined sequence is exactly it. `null` otherwise. */
function matchesSequence(
  sequence: readonly string[],
  side: readonly CredentialVersion[]
): readonly CredentialVersion[] | null {
  if (sequence.length !== side.length) return null;
  for (const [index, version] of side.entries()) {
    if (sequence[index] !== identityOf(version)) return null;
  }
  return side;
}
