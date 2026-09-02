// SPDX-License-Identifier: GPL-3.0-or-later
import {
  SECRET_VERSIONED_FIELDS,
  VERSIONED_FIELDS,
  type ChangeOrigin,
  type Credential,
  type CredentialVersion,
  type VersionedField,
  type VersionedValues,
} from '@shared/model/credential.js';
import {
  applyPatch,
  type CredentialPatch,
  type FieldsPatch,
  type OpsContext,
} from '../vault/credential-ops.js';

/**
 * Versioning: recording what a record used to hold, and putting it back.
 *
 * Pure throughout. Nothing here touches a key, a file, a clock or the machine — `now` and
 * the origin arrive as arguments. That is what lets the whole of Keyhold's headline
 * feature be tested without unlocking a vault, and it is the reason the rules about what a
 * version *means* are worth writing down here rather than scattered through the service.
 *
 * ## Deltas point backwards
 *
 * A version stores the values that were **replaced**, so the state at any point is
 * reconstructed by starting from the current record and walking backwards. See
 * `CredentialVersion` for why: retention prunes the oldest versions, and backward deltas
 * are the direction that keeps every *surviving* version restorable.
 *
 * ## Every timeline entry is a restorable state
 *
 * The user model this file implements is deliberately simple: an entry says "on this date,
 * from this device, these fields changed", and restoring it puts the record back to how it
 * was **before** that change. So `resolveState(credential, n)` is both what the diff for
 * entry `n` shows on its left-hand side and what restoring entry `n` produces. One
 * function, one meaning, no chance of the timeline and the restore button disagreeing.
 *
 * ## A restore is itself a change
 *
 * Restoring records a new version with `action: 'restore'`, capturing the device and
 * network it was done from. Anything else would make the one operation that rewrites a
 * record the one operation the audit trail cannot see, which is exactly backwards.
 */

const SECRET_VERSIONED = new Set<VersionedField>(SECRET_VERSIONED_FIELDS);

/** Where in the timeline to look. `'current'` is the live record. */
export type HistoryPoint = number | 'current';

export interface FieldDiff {
  readonly field: VersionedField;
  readonly before: VersionedValues[VersionedField];
  readonly after: VersionedValues[VersionedField];
  /** True when the values are secret material, so a caller knows not to log them. */
  readonly isSecret: boolean;
}

/** The record's current values, in versioned shape. The base every walk starts from. */
export function currentValues(credential: Credential): Required<VersionedValues> {
  return {
    title: credential.title,
    username: credential.fields.username,
    email: credential.fields.email,
    password: credential.fields.password,
    urls: credential.fields.urls,
    securityQuestions: credential.fields.securityQuestions,
    notes: credential.fields.notes,
    custom: credential.fields.custom,
    tags: credential.tags,
    folderId: credential.folderId,
    favorite: credential.favorite,
    icon: credential.icon,
    expiresAt: credential.meta.expiresAt,
    rotationIntervalDays: credential.meta.rotationIntervalDays,
  };
}

/**
 * Narrows `applyPatch`'s change list to the fields history actually records.
 *
 * `changedFields` carries everything that made the record dirty, which includes
 * `historyEnabled` — a real change that must be saved but has nothing to show in a
 * timeline. Filtering here rather than at the call site means a caller cannot forget.
 */
export function versionedChanges(changedFields: readonly string[]): VersionedField[] {
  const versioned = new Set<string>(VERSIONED_FIELDS);
  return changedFields.filter((field): field is VersionedField => versioned.has(field));
}

function snapshotOf(previous: Credential, fields: readonly VersionedField[]): VersionedValues {
  const before = currentValues(previous);
  // Explicit copy of exactly the changed keys. A spread of `before` would store every
  // field on every edit — including every unchanged secret, once per save, forever.
  const snapshot: VersionedValues = {};
  for (const field of fields) {
    (snapshot as Record<string, unknown>)[field] = before[field];
  }
  return snapshot;
}

/**
 * Drops the oldest versions beyond the cap.
 *
 * `null` means unlimited. `0` keeps none, which is a meaningful setting distinct from
 * disabling history: the record still records *that* it changed for the current save and
 * then keeps nothing, and turning the cap back up starts accumulating again without the
 * per-record checkbox moving.
 *
 * Version numbers are never renumbered after a prune. An exported timeline, a bug report
 * quoting "version 12", and a UI holding a selection all keep meaning something.
 */
export function pruneVersions(
  versions: readonly CredentialVersion[],
  maxVersions: number | null
): readonly CredentialVersion[] {
  if (maxVersions === null) return versions;
  if (maxVersions <= 0) return [];
  if (versions.length <= maxVersions) return versions;
  return versions.slice(versions.length - maxVersions);
}

/**
 * Appends the version describing one change, and prunes.
 *
 * Returns `updated` untouched when history is off for the record, when nothing versioned
 * changed, or when the cap is zero — so a caller can append unconditionally and let the
 * record's own settings decide. `savedAt` is taken from `updated.meta.updatedAt` rather
 * than a fresh clock read, so the version and the record it describes agree to the
 * millisecond.
 */
export function appendVersion(
  updated: Credential,
  previous: Credential,
  changedFields: readonly string[],
  origin: ChangeOrigin
): Credential {
  if (!updated.history.enabled) return updated;

  const versioned = versionedChanges(changedFields);
  if (versioned.length === 0) return updated;

  const last = updated.history.versions[updated.history.versions.length - 1];
  const version: CredentialVersion = {
    versionNumber: (last?.versionNumber ?? 0) + 1,
    savedAt: updated.meta.updatedAt,
    changedFields: versioned,
    snapshot: snapshotOf(previous, versioned),
    origin,
  };

  return {
    ...updated,
    history: {
      ...updated.history,
      versions: pruneVersions([...updated.history.versions, version], updated.history.maxVersions),
    },
  };
}

/** The index of a version in the record's array, or `-1`. */
function indexOfVersion(credential: Credential, versionNumber: number): number {
  return credential.history.versions.findIndex(
    (version) => version.versionNumber === versionNumber
  );
}

/**
 * The record's values at one point in the timeline.
 *
 * Walks backwards from the present, applying each version's snapshot in turn, so the
 * result is the state that existed **before** the change `versionNumber` describes.
 * Returns `null` when the version is not in the record — pruned, or never existed — rather
 * than a partial reconstruction, because a half-reconstructed record offered as a restore
 * target would quietly write the wrong values.
 */
export function resolveState(
  credential: Credential,
  point: HistoryPoint
): Required<VersionedValues> | null {
  const values: Record<string, unknown> = currentValues(credential);
  if (point === 'current') return values as Required<VersionedValues>;

  const target = indexOfVersion(credential, point);
  if (target === -1) return null;

  const versions = credential.history.versions;
  for (let index = versions.length - 1; index >= target; index -= 1) {
    const snapshot = versions[index]?.snapshot;
    if (snapshot === undefined) continue;
    for (const [field, value] of Object.entries(snapshot)) values[field] = value;
  }
  return values as Required<VersionedValues>;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Arrays and the icon object are compared structurally. These are small, JSON-shaped
  // values that already round-trip through the vault file, so serialisation is a faithful
  // equality here and avoids a bespoke deep-compare per field type.
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The field-level difference between two points, in `VERSIONED_FIELDS` order. */
export function diffStates(
  before: Required<VersionedValues>,
  after: Required<VersionedValues>
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const field of VERSIONED_FIELDS) {
    if (sameValue(before[field], after[field])) continue;
    diffs.push({
      field,
      before: before[field],
      after: after[field],
      isSecret: SECRET_VERSIONED.has(field),
    });
  }
  return diffs;
}

/**
 * The diff for one timeline entry: what that edit changed.
 *
 * `null` when the version is not in the record. Note that this compares the *whole* state
 * either side of the change rather than trusting `changedFields`, so a version written by
 * an older build with a wrong change list still produces an honest diff.
 */
export function diffVersion(credential: Credential, versionNumber: number): FieldDiff[] | null {
  const before = resolveState(credential, versionNumber);
  if (before === null) return null;

  const versions = credential.history.versions;
  const index = indexOfVersion(credential, versionNumber);
  const next = versions[index + 1];
  const after = resolveState(credential, next === undefined ? 'current' : next.versionNumber);
  if (after === null) return null;

  return diffStates(before, after);
}

/** The difference between any two points in the timeline. `null` if either is unknown. */
export function comparePoints(
  credential: Credential,
  from: HistoryPoint,
  to: HistoryPoint
): FieldDiff[] | null {
  const before = resolveState(credential, from);
  const after = resolveState(credential, to);
  if (before === null || after === null) return null;
  return diffStates(before, after);
}

function patchFromValues(values: VersionedValues): CredentialPatch {
  // Assembled field by field rather than spread, for the reason the whole codebase does
  // it: under `exactOptionalPropertyTypes` a spread widens every optional key to include
  // `undefined`, and "absent" means "leave it alone" to `applyPatch` while an explicit
  // `undefined` does not.
  const patch: {
    title?: string;
    favorite?: boolean;
    folderId?: string | null;
    tags?: readonly string[];
    icon?: Credential['icon'];
    fields?: FieldsPatch;
    meta?: { expiresAt?: number | null; rotationIntervalDays?: number | null };
  } = {};
  const fields: FieldsPatch = {};
  const meta: { expiresAt?: number | null; rotationIntervalDays?: number | null } = {};

  if (values.title !== undefined) patch.title = values.title;
  if (values.favorite !== undefined) patch.favorite = values.favorite;
  if (values.folderId !== undefined) patch.folderId = values.folderId;
  if (values.tags !== undefined) patch.tags = values.tags;
  if (values.icon !== undefined) patch.icon = values.icon;

  const assign = (key: keyof FieldsPatch, value: unknown): void => {
    if (value !== undefined) (fields as Record<string, unknown>)[key] = value;
  };
  assign('username', values.username);
  assign('email', values.email);
  assign('password', values.password);
  assign('urls', values.urls);
  assign('securityQuestions', values.securityQuestions);
  assign('notes', values.notes);
  assign('custom', values.custom);
  if (Object.keys(fields).length > 0) patch.fields = fields;

  if (values.expiresAt !== undefined) meta.expiresAt = values.expiresAt;
  if (values.rotationIntervalDays !== undefined) {
    meta.rotationIntervalDays = values.rotationIntervalDays;
  }
  if (Object.keys(meta).length > 0) patch.meta = meta;

  return patch;
}

export interface RestoreResult {
  readonly credential: Credential;
  readonly changedFields: readonly string[];
}

/**
 * Restores the record to the state before `versionNumber`, recording the restore itself.
 *
 * `null` when the version is unknown. A restore that changes nothing — restoring to a
 * state the record is already in — returns the record untouched with an empty change list
 * rather than writing a version documenting that nothing happened.
 *
 * The restore goes through `applyPatch`, so it is validated exactly like a hand edit. A
 * version written by a corrupted file cannot bypass the record's own invariants by
 * arriving through the history door.
 */
export function restoreVersion(
  credential: Credential,
  versionNumber: number,
  origin: ChangeOrigin,
  context: OpsContext
): RestoreResult | null {
  const state = resolveState(credential, versionNumber);
  if (state === null) return null;
  return applyRestore(credential, state, origin, context);
}

/**
 * Restores one field from one version, leaving everything else alone.
 *
 * The common case by a distance: "that was the password I used before", without undoing
 * six months of other edits.
 */
export function restoreField(
  credential: Credential,
  versionNumber: number,
  field: VersionedField,
  origin: ChangeOrigin,
  context: OpsContext
): RestoreResult | null {
  const state = resolveState(credential, versionNumber);
  if (state === null) return null;
  const single: VersionedValues = {};
  (single as Record<string, unknown>)[field] = state[field];
  return applyRestore(credential, single, origin, context);
}

function applyRestore(
  credential: Credential,
  values: VersionedValues,
  origin: ChangeOrigin,
  context: OpsContext
): RestoreResult {
  const { credential: updated, changedFields } = applyPatch(
    credential,
    patchFromValues(values),
    context
  );
  if (changedFields.length === 0) return { credential, changedFields: [] };

  return {
    credential: appendVersion(updated, credential, changedFields, origin),
    changedFields,
  };
}

/**
 * Reads one secret value out of a historical version.
 *
 * Returns `null` when the version is unknown *or* when that version did not record the
 * field — which is the normal case, since a version only stores what changed. A caller
 * must not treat "not recorded" as "was empty": the value at that point in time is
 * recoverable through `resolveState`, and this function deliberately does not do it
 * implicitly, because the two answers mean different things to a UI.
 */
export function historicSecret(
  credential: Credential,
  versionNumber: number,
  field: VersionedField
): VersionedValues[VersionedField] | null {
  const version = credential.history.versions.find(
    (candidate) => candidate.versionNumber === versionNumber
  );
  if (version === undefined) return null;
  const value = version.snapshot[field];
  return value === undefined ? null : value;
}

/**
 * Checks the invariants a version array must satisfy.
 *
 * Called when a vault is loaded, because these can only be violated by a corrupt file, a
 * bug, or a merge — and all three are exactly when a silent violation would be worst.
 * Throws with a message naming the record, since the point is to be fixable.
 */
export function assertValidHistory(credential: Credential): void {
  const { versions, maxVersions } = credential.history;

  if (maxVersions !== null && (!Number.isInteger(maxVersions) || maxVersions < 0)) {
    throw new Error(`${credential.id}: history.maxVersions must be a non-negative integer or null`);
  }
  if (maxVersions !== null && versions.length > maxVersions) {
    throw new Error(
      `${credential.id}: ${versions.length} versions exceeds the cap of ${maxVersions}`
    );
  }

  let previousNumber = 0;
  const versioned = new Set<string>(VERSIONED_FIELDS);
  for (const version of versions) {
    if (!Number.isInteger(version.versionNumber) || version.versionNumber <= previousNumber) {
      throw new Error(
        `${credential.id}: version numbers must strictly ascend (saw ${version.versionNumber} after ${previousNumber})`
      );
    }
    previousNumber = version.versionNumber;

    for (const field of version.changedFields) {
      if (!versioned.has(field)) {
        throw new Error(
          `${credential.id}: version ${version.versionNumber} names unknown field "${field}"`
        );
      }
    }
    // The snapshot may hold *fewer* keys than `changedFields` — a version written before a
    // field existed — but never more. A key outside the change list is a value the timeline
    // would silently apply during a restore without ever showing it in the diff.
    for (const key of Object.keys(version.snapshot)) {
      if (!version.changedFields.includes(key as VersionedField)) {
        throw new Error(
          `${credential.id}: version ${version.versionNumber} snapshots "${key}", which it does not list as changed`
        );
      }
    }
  }
}
