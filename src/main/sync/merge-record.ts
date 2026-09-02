// SPDX-License-Identifier: GPL-3.0-or-later
import {
  VERSIONED_FIELDS,
  type ChangeOrigin,
  type Credential,
  type CustomField,
  type SecurityQuestion,
  type VersionedField,
  type VersionedValues,
} from '@shared/model/credential.js';
import type {
  AppliedSide,
  ConflictChoice,
  ConflictSide,
  MergeConflict,
  MergeNote,
  MergeResolution,
} from '@shared/model/sync.js';
import {
  appendVersion,
  assertValidHistory,
  currentValues,
  diffStates,
} from '../history/versioning.js';
import { assertValidCredential, sortCustomFields } from '../vault/credential-ops.js';
import { ABSENT, conflictId, fieldSide, plainSide } from './conflict-projection.js';
import { mergeVersions } from './merge-history.js';
import { mergeKeyedList, mergeTagSet, resolveValue, type Ancestor } from './merge-values.js';
import { canonicallyFirst, largerCap, maxNullable, sameValue } from './stable-value.js';

/**
 * Merging one record.
 *
 * Per **field**, not per record. Two devices editing different fields of the same login is
 * the ordinary case — a phone updates the password while a laptop fixes the title — and a
 * whole-record resolution would make the user throw one of those away to keep the other. So
 * every field is resolved on its own, and only the fields that genuinely moved on both sides
 * become conflicts.
 *
 * ## The rules, in the order they matter
 *
 * **A deletion is never resurrected.** `trashedAt` is a tombstone, and a tombstone wins over
 * a record that is merely present. This is the one asymmetry in the file and it is
 * deliberate: undoing an unwanted deletion is one click in the Trash, while a record that
 * quietly comes back from the dead on every sync is a bug the user cannot fix and, in a
 * password manager, may not even notice.
 *
 * **A tombstone does not discard the other side's edits.** When one side deleted and the
 * other edited, the merged record is trashed *and* carries the merged fields, and a
 * `record-delete-vs-edit` conflict says so. Restoring it from the Trash therefore recovers
 * the newer content, not the state it was deleted in.
 *
 * **No timestamp ever decides a value.** `updatedAt`, `createdAt`, `lastUsedAt` and
 * `passwordUpdatedAt` are carried through a merge, but only by `min`/`max` and only *after*
 * the content decision is made. See the header of `merge-values.ts` for why last-write-wins
 * is a trap rather than a shortcut.
 *
 * **The merged record is validated like a hand edit.** `assertValidCredential` runs on the
 * result, exactly as it does for a restore. A merge that would produce a record violating the
 * model's own invariants fails loudly instead of writing one.
 */

// ── How each versioned field merges ──────────────────────────────────────────

/**
 * The merge strategy for every versioned field.
 *
 * A `Record` over `VersionedField` rather than a `switch` with a default, because that makes
 * classifying a *new* field compulsory: add one to `VersionedValues` and this object stops
 * compiling. The alternative — a default branch — would silently treat a new keyed list as an
 * opaque value, and the user would be asked to choose between two custom-field lists that
 * could have been merged.
 */
type FieldStrategy = 'value' | 'tags' | 'security-questions' | 'custom';

const FIELD_STRATEGY: Readonly<Record<VersionedField, FieldStrategy>> = {
  title: 'value',
  username: 'value',
  email: 'value',
  password: 'value',
  urls: 'value',
  securityQuestions: 'security-questions',
  notes: 'value',
  custom: 'custom',
  tags: 'tags',
  folderId: 'value',
  favorite: 'value',
  icon: 'value',
  expiresAt: 'value',
  rotationIntervalDays: 'value',
};

// ── Inputs and outputs ───────────────────────────────────────────────────────

export interface RecordMergeContext {
  /**
   * Whether the *document* merge had a base snapshot, independently of whether this record
   * appeared in it.
   *
   * The two are genuinely different and a report that ran them together would mislead. "There
   * was no ancestor" means the whole merge was two-way and every difference is a conflict by
   * necessity. "The ancestor did not contain this record" means the record was created
   * independently on both devices — a re-imported export, most plausibly — and the conflicts
   * on it are two-way inside an otherwise three-way merge. The resolver shows the first as an
   * absent base column and the second as a base that says *this did not exist*.
   */
  readonly ancestorKnown: boolean;
  /**
   * The provenance stamped on the version that records the merge itself, or `null` to record
   * nothing.
   *
   * A merge rewrites a record, and the one operation that rewrites a record must not be the
   * one operation the audit trail cannot see — the same argument that makes a restore
   * versioned. `HistoryAction` has carried `'merge'` since the model was written for exactly
   * this. The caller supplies it, so this stays a pure function of its arguments.
   */
  readonly mergeOrigin: ChangeOrigin | null;
  /** User answers to conflicts from an earlier run of this same merge, keyed by conflict id. */
  readonly resolutions: ReadonlyMap<string, ConflictChoice>;
}

export interface RecordMerge {
  readonly credential: Credential;
  readonly conflicts: readonly MergeConflict[];
  readonly notes: readonly MergeNote[];
  /** Attachment ids the merged record references that our side does not hold the bytes for. */
  readonly attachmentsToImport: readonly string[];
}

interface Decision<T> {
  readonly value: T;
  readonly applied: AppliedSide;
  readonly resolution: MergeResolution;
}

/**
 * Folds a user's answer in, if there is one and if there is anything to answer.
 *
 * The resolver never sends a *value* back — it sends a side. That is not a convenience: the
 * values behind a conflict may be passwords, they never crossed to the renderer in the first
 * place, and a resolution protocol that carried them would undo the whole point of projecting
 * the conflict. The merge is simply re-run with the choice folded in, so there is one merge
 * implementation and no second code path that applies resolutions after the fact.
 *
 * `conflict` gates the lookup deliberately. A resolution map outlives the merge it was
 * collected for — the user resolves, an edit lands, the merge is re-run — and by then a field
 * that once disagreed may not. Applying a stale answer to a field that now has one obvious
 * value would overwrite an edit nobody was asked about.
 */
function settle<T>(
  conflict: boolean,
  id: string,
  ours: T,
  theirs: T,
  fallback: Decision<T>,
  resolutions: ReadonlyMap<string, ConflictChoice>
): Decision<T> {
  if (!conflict) return fallback;
  const choice = resolutions.get(id);
  if (choice === 'ours') return { value: ours, applied: 'ours', resolution: 'user' };
  if (choice === 'theirs') return { value: theirs, applied: 'theirs', resolution: 'user' };
  return fallback;
}

// ── The merge ────────────────────────────────────────────────────────────────

export function mergeCredential(
  base: Credential | null,
  ours: Credential,
  theirs: Credential,
  context: RecordMergeContext
): RecordMerge {
  // Identical records are the overwhelmingly common case in a real vault — most records are
  // untouched by most syncs — and returning `ours` by reference is what makes `merge(x, x)`
  // return `x` rather than a structurally-equal rebuild.
  if (sameValue(ours, theirs)) {
    return { credential: ours, conflicts: [], notes: [], attachmentsToImport: [] };
  }

  const conflicts: MergeConflict[] = [];
  const notes: MergeNote[] = [];
  const { resolutions } = context;

  const oursValues = currentValues(ours);
  const theirsValues = currentValues(theirs);
  const baseValues = base === null ? null : currentValues(base);

  // `null` when the merge is two-way; `ABSENT` when it is three-way and this record is new to
  // both sides. See `RecordMergeContext.ancestorKnown` for why the two are kept apart.
  const baseSideOf = (
    project: (values: Required<VersionedValues>) => ConflictSide
  ): ConflictSide | null =>
    !context.ancestorKnown ? null : baseValues === null ? ABSENT : project(baseValues);

  const baseSideOfRecord = (project: (record: Credential) => ConflictSide): ConflictSide | null =>
    !context.ancestorKnown ? null : base === null ? ABSENT : project(base);

  // ── Versioned fields ───────────────────────────────────────────────────────
  const merged: Record<string, unknown> = { ...oursValues };

  for (const field of VERSIONED_FIELDS) {
    const id = conflictId.recordField(ours.id, field);

    switch (FIELD_STRATEGY[field]) {
      case 'tags': {
        // Only `tags` maps to this strategy, so reading the field by name is safe and keeps
        // the element type honest without a cast. A set merge cannot conflict — see
        // `mergeTagSet` — so there is nothing to settle and nothing to report.
        merged.tags = mergeTagSet(baseValues?.tags ?? null, oursValues.tags, theirsValues.tags);
        break;
      }
      case 'security-questions': {
        const outcome = mergeKeyedList<SecurityQuestion>(
          baseValues?.securityQuestions ?? null,
          oursValues.securityQuestions,
          theirsValues.securityQuestions
        );
        const chosen = settle(
          outcome.conflict,
          id,
          oursValues.securityQuestions,
          theirsValues.securityQuestions,
          { value: outcome.items, applied: 'merged', resolution: 'unresolved' },
          resolutions
        );
        merged.securityQuestions = chosen.value;
        if (outcome.conflict) {
          conflicts.push(
            recordFieldConflict(
              id,
              ours.id,
              field,
              oursValues,
              theirsValues,
              baseSideOf((values) => fieldSide(field, values[field])),
              chosen
            )
          );
        }
        break;
      }
      case 'custom': {
        const outcome = mergeKeyedList<CustomField>(
          baseValues?.custom ?? null,
          oursValues.custom,
          theirsValues.custom
        );
        const chosen = settle(
          outcome.conflict,
          id,
          oursValues.custom,
          theirsValues.custom,
          { value: outcome.items, applied: 'merged', resolution: 'unresolved' },
          resolutions
        );
        // Re-sorted and renumbered by the same function every other write path uses, so a
        // merged record's `order` values are contiguous exactly as a hand-edited one's are.
        merged.custom = sortCustomFields(chosen.value);
        if (outcome.conflict) {
          conflicts.push(
            recordFieldConflict(
              id,
              ours.id,
              field,
              oursValues,
              theirsValues,
              baseSideOf((values) => fieldSide(field, values[field])),
              chosen
            )
          );
        }
        break;
      }
      case 'value': {
        const ancestor: Ancestor<VersionedValues[VersionedField]> =
          baseValues === null ? null : { value: baseValues[field] };
        const outcome = resolveValue(ancestor, oursValues[field], theirsValues[field]);
        const chosen = settle(
          outcome.conflict,
          id,
          oursValues[field],
          theirsValues[field],
          { value: outcome.value, applied: outcome.from, resolution: 'unresolved' },
          resolutions
        );
        merged[field] = chosen.value;
        if (outcome.conflict) {
          conflicts.push(
            recordFieldConflict(
              id,
              ours.id,
              field,
              oursValues,
              theirsValues,
              baseSideOf((values) => fieldSide(field, values[field])),
              chosen
            )
          );
        }
        break;
      }
    }
  }

  const mergedValues = merged as Required<VersionedValues>;

  // ── Trash ──────────────────────────────────────────────────────────────────
  const trash = mergeTrash(base, ours, theirs, {
    oursEdited: baseValues !== null && !sameValue(oursValues, baseValues),
    theirsEdited: baseValues !== null && !sameValue(theirsValues, baseValues),
    contentDiffers: !sameValue(oursValues, theirsValues),
  });
  const trashId = conflictId.recordTrash(ours.id);
  const trashChoice = settle(
    trash.conflict,
    trashId,
    ours.trashedAt,
    theirs.trashedAt,
    { value: trash.trashedAt, applied: trash.applied, resolution: 'unresolved' },
    resolutions
  );
  if (trash.conflict) {
    conflicts.push({
      id: trashId,
      kind: 'record-delete-vs-edit',
      targetId: ours.id,
      field: 'trashedAt',
      ours: plainSide(ours.trashedAt),
      theirs: plainSide(theirs.trashedAt),
      base: baseSideOfRecord((record) => plainSide(record.trashedAt)),
      applied: trashChoice.applied,
      resolution: trashChoice.resolution,
    });
  }
  if (trash.note !== null) notes.push({ kind: trash.note, targetId: ours.id, count: null });

  // ── Attachments ────────────────────────────────────────────────────────────
  const attachments = mergeKeyedList(
    base?.attachments ?? null,
    ours.attachments,
    theirs.attachments
  );
  const ourChunks = new Set(ours.attachments.map((attachment) => attachment.id));
  const attachmentsToImport = attachments.items
    .map((attachment) => attachment.id)
    .filter((id) => !ourChunks.has(id));
  for (const id of attachmentsToImport) {
    notes.push({ kind: 'attachment-needed', targetId: id, count: null });
  }
  if (attachments.conflict) {
    // Two records claiming the same chunk id with different metadata. Effectively impossible —
    // chunk ids are random — but reported rather than swallowed, because if it ever happens it
    // means something upstream is reusing ids and that is worth seeing. The sides carry ids,
    // which are random identifiers and reveal nothing, never names or sizes.
    //
    // `'policy'` rather than `'unresolved'`, deliberately, and it is the one place in the file
    // where that label is doing slightly more work than it looks: the clashing entry keeps
    // *our* metadata, because `mergeKeyedList` has no way to combine two descriptions of one
    // chunk and this engine will not tie-break between them. Marking it unresolved would be
    // worse than imprecise — the conflict is not wired into `settle`, so a merge that blocked
    // on it could never be made to converge by answering it. The honest reading is: reported,
    // never silent, and ours wins a clash that should not be able to occur.
    conflicts.push({
      id: conflictId.recordField(ours.id, 'attachments'),
      kind: 'record-field',
      targetId: ours.id,
      field: 'attachments',
      ours: plainSide(ours.attachments.map((attachment) => attachment.id)),
      theirs: plainSide(theirs.attachments.map((attachment) => attachment.id)),
      base: baseSideOfRecord((record) => plainSide(record.attachments.map((a) => a.id))),
      applied: 'merged',
      resolution: 'policy',
    });
  }

  // ── History settings ───────────────────────────────────────────────────────
  const history = mergeHistorySettings(
    base,
    ours,
    theirs,
    resolutions,
    conflicts,
    baseSideOfRecord
  );

  const versions = mergeVersions(
    base === null ? null : base.history.versions,
    ours.history.versions,
    theirs.history.versions,
    history.maxVersions
  );
  if (versions.renumbered) {
    notes.push({
      kind: 'history-renumbered',
      targetId: ours.id,
      count: versions.versions.length,
    });
  }
  if (versions.dropped > 0) {
    notes.push({ kind: 'history-truncated', targetId: ours.id, count: versions.dropped });
  }

  // ── Metadata ───────────────────────────────────────────────────────────────
  const candidate: Credential = {
    id: ours.id,
    type: ours.type,
    title: mergedValues.title,
    favorite: mergedValues.favorite,
    folderId: mergedValues.folderId,
    tags: mergedValues.tags,
    icon: mergedValues.icon,
    fields: {
      username: mergedValues.username,
      email: mergedValues.email,
      password: mergedValues.password,
      urls: mergedValues.urls,
      securityQuestions: mergedValues.securityQuestions,
      notes: mergedValues.notes,
      custom: mergedValues.custom,
    },
    attachments: attachments.items,
    meta: mergeMeta(base, ours, theirs, mergedValues),
    history: {
      enabled: history.enabled,
      maxVersions: history.maxVersions,
      versions: versions.versions,
    },
    trashedAt: trashChoice.value,
  };

  // ── Record the merge in the timeline ───────────────────────────────────────
  const changed = diffStates(oursValues, currentValues(candidate)).map((diff) => diff.field);
  const credential =
    context.mergeOrigin === null || changed.length === 0
      ? candidate
      : appendVersion(candidate, ours, changed, context.mergeOrigin);

  // A merged record is held to exactly the invariants a hand-edited one is. A merge that
  // would produce an invalid record — two custom fields with one id, a field over its
  // length cap — must fail here rather than be written to a vault file. `assertValidHistory`
  // is the half that matters most: interleaving two timelines is the operation most able to
  // produce a version array that looks fine and restores the wrong values.
  assertValidCredential(credential);
  assertValidHistory(credential);

  return { credential, conflicts, notes, attachmentsToImport };
}

// ── Conflict construction ────────────────────────────────────────────────────

function recordFieldConflict(
  id: string,
  credentialId: string,
  field: VersionedField,
  ours: Required<VersionedValues>,
  theirs: Required<VersionedValues>,
  base: ConflictSide | null,
  chosen: Decision<unknown>
): MergeConflict {
  return {
    id,
    kind: 'record-field',
    targetId: credentialId,
    field,
    ours: fieldSide(field, ours[field]),
    theirs: fieldSide(field, theirs[field]),
    base,
    applied: chosen.applied,
    resolution: chosen.resolution,
  };
}

// ── Trash ────────────────────────────────────────────────────────────────────

interface TrashInputs {
  readonly oursEdited: boolean;
  readonly theirsEdited: boolean;
  readonly contentDiffers: boolean;
}

interface TrashMerge {
  readonly trashedAt: number | null;
  readonly conflict: boolean;
  readonly applied: AppliedSide;
  readonly note: MergeNote['kind'] | null;
}

/**
 * Resolves the delete/undelete axis.
 *
 * `trashedAt` is not merged as an ordinary field, because it does not mean what an ordinary
 * field means: it is the **tombstone**, and it is the only thing in the model that can say
 * "this record was deliberately removed". Without it, a record present on one side and absent
 * on the other is indistinguishable from a record the other side has simply never seen — so
 * treating the tombstone as just another value to resolve would put the deletion up for a vote
 * it can lose.
 *
 * Both sides trashed at different instants keeps the **later** timestamp. Trash retention
 * measures from `trashedAt`, so the later of the two gives the user the longer window to
 * change their mind, and `Math.max` is commutative — no clock wins anything, it just does not
 * purge sooner than either device intended.
 */
function mergeTrash(
  base: Credential | null,
  ours: Credential,
  theirs: Credential,
  inputs: TrashInputs
): TrashMerge {
  if (ours.trashedAt === theirs.trashedAt) {
    return { trashedAt: ours.trashedAt, conflict: false, applied: 'ours', note: null };
  }
  if (ours.trashedAt !== null && theirs.trashedAt !== null) {
    const later = Math.max(ours.trashedAt, theirs.trashedAt);
    return {
      trashedAt: later,
      conflict: false,
      applied: later === ours.trashedAt ? 'ours' : 'theirs',
      note: null,
    };
  }

  const trashingIsOurs = ours.trashedAt !== null;
  const tombstone = trashingIsOurs ? ours.trashedAt : theirs.trashedAt;
  const applied: AppliedSide = trashingIsOurs ? 'ours' : 'theirs';
  const otherEdited = trashingIsOurs ? inputs.theirsEdited : inputs.oursEdited;

  if (base !== null) {
    if (base.trashedAt !== null && tombstone === base.trashedAt) {
      // The trashing side did not touch the tombstone; the other side restored the record.
      // Only one side changed, so there is nothing to conflict over — a restore is an edit
      // like any other, and it wins by the ordinary three-way rule.
      return {
        trashedAt: null,
        conflict: false,
        applied: trashingIsOurs ? 'theirs' : 'ours',
        note: 'record-restored',
      };
    }
    if (base.trashedAt === null) {
      // One side deleted a live record. If the other side also edited it, that is a genuine
      // delete-versus-edit and the user is told; the tombstone still wins, and the edits are
      // in the record, waiting behind a Restore button.
      return {
        trashedAt: tombstone,
        conflict: otherEdited,
        applied,
        note: otherEdited ? 'tombstone-preserved' : null,
      };
    }
    // The ancestor was trashed, one side re-trashed it at a different moment and the other
    // restored it. Both moved: a real conflict, and the tombstone holds until it is settled.
    return { trashedAt: tombstone, conflict: true, applied, note: 'tombstone-preserved' };
  }

  // Two-way. There is no ancestor to say whether one side deleted or the other restored, so
  // the tombstone is the only evidence of intent in play and it is honoured. This is the case
  // the tombstone exists for, and the one a naive union gets catastrophically wrong.
  return {
    trashedAt: tombstone,
    conflict: inputs.contentDiffers,
    applied,
    note: 'tombstone-preserved',
  };
}

// ── History settings ─────────────────────────────────────────────────────────

interface HistorySettingsMerge {
  readonly enabled: boolean;
  readonly maxVersions: number | null;
}

/**
 * The per-record history switch and retention cap.
 *
 * Both resolve by **policy** when the two sides disagree, and both policies point the same
 * way: toward the answer that cannot surprise someone.
 *
 *  - `enabled` — **off wins.** Switching history off is a privacy decision about old
 *    passwords. Honouring "on" because the other device said so would resume recording
 *    something a user deliberately stopped recording, and they would have no reason to look.
 *  - `maxVersions` — **the larger cap wins**, with `null` (unlimited) largest. Keeping more
 *    history loses nothing and can be lowered in one click; keeping less destroys entries
 *    immediately and irreversibly.
 *
 * Both are reported as conflicts with `resolution: 'policy'`, so they appear in the report and
 * can be overridden, but do not block the merge. A merge that stops to ask about a retention
 * count is a merge people learn to click through.
 *
 * ## When each policy is actually reachable
 *
 * Worth writing down, because the two differ and the difference is not obvious.
 *
 * `enabled` is a **boolean**, so with an ancestor it can never conflict: if ours differs from
 * the base then theirs either matches the base — one side moved, which is an ordinary edit
 * `resolveValue` settles with no question — or matches ours, in which case both moved the same
 * way. There is no third value left to disagree on. So "off wins" fires only where there is no
 * ancestor to appeal to: a two-way merge, or a record created independently on both devices.
 * That is not a weakness. Where an ancestor exists, "the user turned this off" is a *fact*
 * rather than a preference, and honouring the fact is strictly better than applying a policy.
 *
 * `maxVersions` has an unbounded range, so three distinct values give it a genuine three-way
 * conflict, and the larger-cap policy is reachable with or without an ancestor.
 */
function mergeHistorySettings(
  base: Credential | null,
  ours: Credential,
  theirs: Credential,
  resolutions: ReadonlyMap<string, ConflictChoice>,
  conflicts: MergeConflict[],
  baseSideOfRecord: (project: (record: Credential) => ConflictSide) => ConflictSide | null
): HistorySettingsMerge {
  const enabledId = conflictId.recordHistory(ours.id, 'enabled');
  const enabled = resolveValue(
    base === null ? null : { value: base.history.enabled },
    ours.history.enabled,
    theirs.history.enabled
  );
  const enabledChoice = settle(
    enabled.conflict,
    enabledId,
    ours.history.enabled,
    theirs.history.enabled,
    {
      value: false,
      applied: ours.history.enabled ? 'theirs' : 'ours',
      resolution: 'policy',
    },
    resolutions
  );
  if (enabled.conflict) {
    conflicts.push({
      id: enabledId,
      kind: 'record-history',
      targetId: ours.id,
      field: 'enabled',
      ours: plainSide(ours.history.enabled),
      theirs: plainSide(theirs.history.enabled),
      base: baseSideOfRecord((record) => plainSide(record.history.enabled)),
      applied: enabledChoice.applied,
      resolution: enabledChoice.resolution,
    });
  }

  const capId = conflictId.recordHistory(ours.id, 'maxVersions');
  const cap = resolveValue(
    base === null ? null : { value: base.history.maxVersions },
    ours.history.maxVersions,
    theirs.history.maxVersions
  );
  const larger = largerCap(ours.history.maxVersions, theirs.history.maxVersions);
  const capChoice = settle(
    cap.conflict,
    capId,
    ours.history.maxVersions,
    theirs.history.maxVersions,
    {
      value: larger,
      applied: larger === ours.history.maxVersions ? 'ours' : 'theirs',
      resolution: 'policy',
    },
    resolutions
  );
  if (cap.conflict) {
    conflicts.push({
      id: capId,
      kind: 'record-history',
      targetId: ours.id,
      field: 'maxVersions',
      ours: plainSide(ours.history.maxVersions),
      theirs: plainSide(theirs.history.maxVersions),
      base: baseSideOfRecord((record) => plainSide(record.history.maxVersions)),
      applied: capChoice.applied,
      resolution: capChoice.resolution,
    });
  }

  return {
    enabled: enabled.conflict ? enabledChoice.value : enabled.value,
    maxVersions: cap.conflict ? capChoice.value : cap.value,
  };
}

// ── Metadata ─────────────────────────────────────────────────────────────────

/**
 * The timestamps and counters, merged **after** the content decision and never influencing it.
 *
 *  - `createdAt` — the earlier. A record cannot have been created twice, so the earlier claim
 *    is the true one, and `min` is commutative.
 *  - `createdOrigin` — the origin belonging to that earlier creation. On an exact tie the
 *    canonically smaller one, which is arbitrary but stable: two origins for one creation
 *    instant mean the record was imported twice, and there is no fact of the matter to
 *    recover. Never synthesised, for the reason `normaliseRecord` never synthesises one —
 *    inventing provenance in the feature whose whole value is trustworthy provenance.
 *  - `updatedAt` — the later. **Deliberately not the merge time.** Stamping "now" on every
 *    merged record would make an entire vault look freshly edited, wrecking sort-by-recent and
 *    making the merge itself invisible in the only column a user would look at.
 *  - `passwordUpdatedAt` — follows the password that won, so the "old password" health rule
 *    keeps telling the truth. If both sides ended up on the same password, the *earlier*
 *    stamp: that is when the password in the record actually started being used, and taking
 *    the later one would quietly reset the age of a password that never changed.
 *  - `lastUsedAt` / `useCount` — a use on either device is a use. The count adds the uses each
 *    side accrued *since the ancestor* rather than adding the totals, which would count every
 *    use in the shared past twice on every sync.
 */
function mergeMeta(
  base: Credential | null,
  ours: Credential,
  theirs: Credential,
  mergedValues: Required<VersionedValues>
): Credential['meta'] {
  const createdAt = Math.min(ours.meta.createdAt, theirs.meta.createdAt);
  const createdOrigin =
    ours.meta.createdAt === theirs.meta.createdAt
      ? canonicallyFirst(ours.meta.createdOrigin, theirs.meta.createdOrigin)
      : ours.meta.createdAt < theirs.meta.createdAt
        ? ours.meta.createdOrigin
        : theirs.meta.createdOrigin;

  const matchesOurs = sameValue(mergedValues.password, ours.fields.password);
  const matchesTheirs = sameValue(mergedValues.password, theirs.fields.password);
  const passwordUpdatedAt =
    matchesOurs && matchesTheirs
      ? Math.min(ours.meta.passwordUpdatedAt, theirs.meta.passwordUpdatedAt)
      : matchesOurs
        ? ours.meta.passwordUpdatedAt
        : matchesTheirs
          ? theirs.meta.passwordUpdatedAt
          : Math.min(ours.meta.passwordUpdatedAt, theirs.meta.passwordUpdatedAt);

  const useCount =
    base === null
      ? Math.max(ours.meta.useCount, theirs.meta.useCount)
      : Math.max(
          ours.meta.useCount + theirs.meta.useCount - base.meta.useCount,
          ours.meta.useCount,
          theirs.meta.useCount
        );

  return {
    createdAt,
    updatedAt: Math.max(ours.meta.updatedAt, theirs.meta.updatedAt),
    passwordUpdatedAt,
    lastUsedAt: maxNullable(ours.meta.lastUsedAt, theirs.meta.lastUsedAt),
    useCount,
    expiresAt: mergedValues.expiresAt,
    rotationIntervalDays: mergedValues.rotationIntervalDays,
    createdOrigin,
  };
}
