// SPDX-License-Identifier: GPL-3.0-or-later
import {
  SECRET_VERSIONED_FIELDS,
  type VersionedField,
  type VersionedValues,
} from '@shared/model/credential.js';
import type { DiffSide, DiffValue } from '@shared/model/history.js';
import type { ConflictSide } from '@shared/model/sync.js';
import { toDiffProjection } from '../history/diff-projection.js';

/**
 * Turns the two values behind a conflict into something the resolver may hold.
 *
 * A merge conflict is the single most dangerous structure in this codebase to build casually.
 * It is, by construction, *two of the thing that differs* — and for `password`, `notes`,
 * `securityQuestions` and `custom`, the thing that differs is secret material. A conflict
 * report that carried its values would put two passwords in a structure whose entire purpose
 * is to be rendered in a list, sent over IPC, and quite possibly saved as a merge log.
 *
 * ## This file deliberately implements nothing
 *
 * The rule for "how does a versioned value cross the bridge safely" already exists, in
 * `../history/diff-projection.ts`, and it is already tested and already fault-injected. A
 * second implementation here would be a second list in the sense of hard rule 8 — and the way
 * that fails is not a crash, it is one of the two copies quietly gaining a case the other
 * never got.
 *
 * So a conflict side is produced by handing the value to `toDiffProjection` as a degenerate
 * diff and taking one end of it. Slightly odd to read; impossible to get wrong. If a new
 * secret field is ever added to the model, it is classified in `credential.ts`, the history
 * projector honours it, and this file inherits that for free.
 */

const SECRET_VERSIONED = new Set<VersionedField>(SECRET_VERSIONED_FIELDS);

/** The side of a conflict where the record, folder, tag or entry does not exist at all. */
export const ABSENT: ConflictSide = { kind: 'absent' };

/**
 * One versioned field value, projected.
 *
 * Both ends of the degenerate diff hold the same value, so it does not matter which one is
 * read back; `before` is taken by convention.
 */
export function fieldSide(field: VersionedField, value: unknown): ConflictSide {
  const typed = value as VersionedValues[VersionedField];
  const projected = toDiffProjection([
    { field, before: typed, after: typed, isSecret: SECRET_VERSIONED.has(field) },
  ])[0];
  // One input, one output. The fallback exists only because the compiler cannot know that,
  // and it is deliberately the emptiest possible side rather than anything derived from
  // `value` — a fallback that reached for the raw value would be a leak on an impossible path.
  return projected?.before ?? { kind: 'value', value: null };
}

/**
 * A value that is not secret by any classification — a folder name, a tag colour, a setting.
 *
 * Separate from `fieldSide` on purpose. `fieldSide` decides secrecy from the field name;
 * there is no field name here, so there is nothing to decide, and the caller is asserting by
 * choosing this function that what it holds cannot be a credential. That assertion is checked
 * by the no-secrets property test, not by this function.
 */
export function plainSide(value: DiffValue): ConflictSide {
  return { kind: 'value', value };
}

/** True when a projected side is a secret's length rather than a value. Used by the tests. */
export function isSecretSide(side: ConflictSide): side is Extract<DiffSide, { kind: 'secret' }> {
  return side.kind === 'secret';
}

// ── Conflict identity ────────────────────────────────────────────────────────

/**
 * Conflict ids, built here so there is one grammar for them.
 *
 * Three things depend on an id being stable and **independent of which document was passed
 * first**: a resolver keeps the user's selections across a re-merge, `MergeOptions.resolutions`
 * is keyed by them, and the commutativity test compares two merges by comparing id sets. An
 * id that embedded "ours" or a positional index would break all three at once, and would break
 * them silently — the resolver would simply stop remembering.
 */
export const conflictId = {
  recordField: (credentialId: string, field: string): string =>
    `record:${credentialId}:field:${field}`,
  recordTrash: (credentialId: string): string => `record:${credentialId}:trash`,
  recordHistory: (credentialId: string, property: string): string =>
    `record:${credentialId}:history:${property}`,
  folder: (folderId: string, property: string): string => `folder:${folderId}:${property}`,
  tag: (tagId: string, property: string): string => `tag:${tagId}:${property}`,
  setting: (key: string): string => `setting:${key}`,
} as const;
