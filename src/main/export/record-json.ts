// SPDX-License-Identifier: GPL-3.0-or-later
import {
  AUDIT_LEVEL_FIELDS,
  CUSTOM_FIELD_TYPES,
  HISTORY_ACTIONS,
  ICON_KINDS,
  VERSIONED_FIELDS,
  type AttachmentMeta,
  type ChangeOrigin,
  type Credential,
  type CredentialFields,
  type CredentialIcon,
  type CredentialMeta,
  type CredentialVersion,
  type CustomField,
  type HistorySettings,
  type SecurityQuestion,
  type VersionedValues,
} from '@shared/model/credential.js';
import { malformed } from '../crypto/errors.js';
import { assertValidHistory } from '../history/versioning.js';
import { assertValidCredential } from '../vault/credential-ops.js';
import {
  requireArray,
  requireBoolean,
  requireMember,
  requireNullableNumber,
  requireNullableString,
  requireNumber,
  requireObject,
  requireString,
  requireStringArray,
  type Mutable,
} from './json-shape.js';

/**
 * One credential, to JSON and back, losing nothing.
 *
 * ## Why this is written out field by field
 *
 * `JSON.stringify(record)` would have been one line. It is not used, for two reasons that
 * both bite later rather than now:
 *
 *  1. **Key order would be whatever the object happened to have.** A record that came from
 *     `JSON.parse` carries its key order from the file it was read out of, so the same vault
 *     saved on two machines would serialise to different bytes. Determinism is a stated
 *     requirement of this engine, and it cannot be bolted on afterwards.
 *
 *  2. **A new field would silently join the export.** Today every field of a credential
 *     belongs in a full-fidelity dump — but "spread whatever the object has" is also how a
 *     future cached, derived or transient field ends up in a plaintext file nobody decided
 *     to put it in. Naming each field means adding one is a deliberate edit here.
 *
 * The parser is the mirror image and treats its input as hostile — see `json-shape.ts`.
 * `assertValidCredential` and `assertValidHistory` are the final gate, so the rules about
 * what a valid record is stay in the modules that own them rather than being restated here.
 */

// ── Serialisation ────────────────────────────────────────────────────────────

export function serialiseRecord(record: Credential): Record<string, unknown> {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    favorite: record.favorite,
    folderId: record.folderId,
    tags: [...record.tags],
    icon: serialiseIcon(record.icon),
    fields: serialiseFields(record.fields),
    attachments: record.attachments.map(serialiseAttachment),
    meta: serialiseMeta(record.meta),
    history: serialiseHistory(record.history),
    trashedAt: record.trashedAt,
  };
}

function serialiseIcon(icon: CredentialIcon): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: icon.kind };
  if (icon.value !== undefined) out.value = icon.value;
  return out;
}

function serialiseFields(fields: CredentialFields): Record<string, unknown> {
  return {
    username: fields.username,
    email: fields.email,
    password: fields.password,
    urls: [...fields.urls],
    securityQuestions: fields.securityQuestions.map(serialiseQuestion),
    notes: fields.notes,
    custom: fields.custom.map(serialiseCustomField),
  };
}

function serialiseQuestion(question: SecurityQuestion): Record<string, unknown> {
  return { id: question.id, question: question.question, answer: question.answer };
}

function serialiseCustomField(field: CustomField): Record<string, unknown> {
  return {
    id: field.id,
    label: field.label,
    type: field.type,
    value: field.value,
    hidden: field.hidden,
    order: field.order,
  };
}

function serialiseAttachment(attachment: AttachmentMeta): Record<string, unknown> {
  return {
    id: attachment.id,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    sha256: attachment.sha256,
    addedAt: attachment.addedAt,
  };
}

function serialiseMeta(meta: CredentialMeta): Record<string, unknown> {
  return {
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    passwordUpdatedAt: meta.passwordUpdatedAt,
    lastUsedAt: meta.lastUsedAt,
    useCount: meta.useCount,
    expiresAt: meta.expiresAt,
    rotationIntervalDays: meta.rotationIntervalDays,
    createdOrigin: serialiseOrigin(meta.createdOrigin),
  };
}

function serialiseHistory(history: HistorySettings): Record<string, unknown> {
  return {
    enabled: history.enabled,
    maxVersions: history.maxVersions,
    versions: history.versions.map(serialiseVersion),
  };
}

function serialiseVersion(version: CredentialVersion): Record<string, unknown> {
  return {
    versionNumber: version.versionNumber,
    savedAt: version.savedAt,
    changedFields: [...version.changedFields],
    snapshot: serialiseSnapshot(version.snapshot),
    origin: serialiseOrigin(version.origin),
  };
}

/**
 * The origin, in `AUDIT_LEVEL_FIELDS.full` order.
 *
 * That array is the model's own statement of every field an origin can carry, so iterating
 * it means this serialiser gains a field the moment the audit levels do — rather than
 * quietly dropping it, which in the one part of the app whose entire value is provenance
 * would be the worst possible silent failure.
 */
function serialiseOrigin(origin: ChangeOrigin): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of AUDIT_LEVEL_FIELDS.full) {
    const value = origin[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * A version's previous values, in `VERSIONED_FIELDS` order.
 *
 * Same reasoning as the origin: the model already declares the canonical order a diff should
 * present these in, so the export uses it rather than inventing a second one.
 * `keyhold-json.test.ts` asserts the emitted key order matches that array exactly, which is
 * what keeps the switch below from drifting out of step with it.
 */
function serialiseSnapshot(snapshot: VersionedValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const field of VERSIONED_FIELDS) {
    switch (field) {
      case 'securityQuestions': {
        const value = snapshot.securityQuestions;
        if (value !== undefined) out[field] = value.map(serialiseQuestion);
        break;
      }
      case 'custom': {
        const value = snapshot.custom;
        if (value !== undefined) out[field] = value.map(serialiseCustomField);
        break;
      }
      case 'icon': {
        const value = snapshot.icon;
        if (value !== undefined) out[field] = serialiseIcon(value);
        break;
      }
      case 'urls':
      case 'tags': {
        const value = snapshot[field];
        if (value !== undefined) out[field] = [...value];
        break;
      }
      // The rest are strings, booleans, numbers or null — JSON's own types, which need no
      // transformation and cannot alias a mutable array. Listed rather than left to a
      // `default`, so adding a versioned field of some other shape is a lint error here
      // rather than a value silently written out raw.
      case 'title':
      case 'username':
      case 'email':
      case 'password':
      case 'notes':
      case 'favorite':
      case 'folderId':
      case 'expiresAt':
      case 'rotationIntervalDays': {
        const value = snapshot[field];
        if (value !== undefined) out[field] = value;
        break;
      }
    }
  }

  return out;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

export function parseRecord(raw: unknown, path: string): Credential {
  const source = requireObject(raw, path);

  const type = requireString(source.type, `${path}.type`);
  if (type !== 'login') {
    // Every record is a login today. Refusing an unknown type is the honest response: a
    // future Keyhold may add card or identity records, and quietly importing one as a login
    // would scatter its fields into places nothing will look for them again.
    throw malformed(`"${path}.type" is "${type}", which this build cannot read`);
  }

  const record: Credential = {
    id: requireString(source.id, `${path}.id`),
    type: 'login',
    title: requireString(source.title, `${path}.title`),
    favorite: requireBoolean(source.favorite, `${path}.favorite`),
    folderId: requireNullableString(source.folderId, `${path}.folderId`),
    tags: requireStringArray(source.tags, `${path}.tags`),
    icon: parseIcon(source.icon, `${path}.icon`),
    fields: parseFields(source.fields, `${path}.fields`),
    attachments: requireArray(source.attachments, `${path}.attachments`).map((item, index) =>
      parseAttachment(item, `${path}.attachments[${index}]`)
    ),
    meta: parseMeta(source.meta, `${path}.meta`),
    history: parseHistory(source.history, `${path}.history`),
    trashedAt: requireNullableNumber(source.trashedAt, `${path}.trashedAt`),
  };

  // The two authorities on what a valid record is, rather than a third opinion here.
  assertValidCredential(record);
  try {
    assertValidHistory(record);
  } catch (error) {
    throw malformed(error instanceof Error ? error.message : `${path} has invalid history`);
  }

  return record;
}

function parseIcon(raw: unknown, path: string): CredentialIcon {
  const source = requireObject(raw, path);
  const icon: Mutable<CredentialIcon> = {
    kind: requireMember(source.kind, `${path}.kind`, ICON_KINDS),
  };
  // Assigned rather than spread: under `exactOptionalPropertyTypes`, `{ value: undefined }`
  // is not the same type as an absent key, and it would also make a round-trip comparison
  // report a difference that is not there.
  if (source.value !== undefined) icon.value = requireString(source.value, `${path}.value`);
  return icon;
}

function parseFields(raw: unknown, path: string): CredentialFields {
  const source = requireObject(raw, path);
  return {
    username: requireString(source.username, `${path}.username`),
    email: requireString(source.email, `${path}.email`),
    password: requireString(source.password, `${path}.password`),
    urls: requireStringArray(source.urls, `${path}.urls`),
    securityQuestions: parseQuestions(source.securityQuestions, `${path}.securityQuestions`),
    notes: requireString(source.notes, `${path}.notes`),
    custom: parseCustomFields(source.custom, `${path}.custom`),
  };
}

function parseQuestions(raw: unknown, path: string): SecurityQuestion[] {
  return requireArray(raw, path).map((item, index) => {
    const source = requireObject(item, `${path}[${index}]`);
    return {
      id: requireString(source.id, `${path}[${index}].id`),
      question: requireString(source.question, `${path}[${index}].question`),
      answer: requireString(source.answer, `${path}[${index}].answer`),
    };
  });
}

function parseCustomFields(raw: unknown, path: string): CustomField[] {
  return requireArray(raw, path).map((item, index) => {
    const source = requireObject(item, `${path}[${index}]`);
    return {
      id: requireString(source.id, `${path}[${index}].id`),
      label: requireString(source.label, `${path}[${index}].label`),
      type: requireMember(source.type, `${path}[${index}].type`, CUSTOM_FIELD_TYPES),
      value: requireString(source.value, `${path}[${index}].value`),
      hidden: requireBoolean(source.hidden, `${path}[${index}].hidden`),
      order: requireNumber(source.order, `${path}[${index}].order`),
    };
  });
}

function parseAttachment(raw: unknown, path: string): AttachmentMeta {
  const source = requireObject(raw, path);
  return {
    id: requireString(source.id, `${path}.id`),
    name: requireString(source.name, `${path}.name`),
    mime: requireString(source.mime, `${path}.mime`),
    size: requireNumber(source.size, `${path}.size`),
    sha256: requireString(source.sha256, `${path}.sha256`),
    addedAt: requireNumber(source.addedAt, `${path}.addedAt`),
  };
}

function parseMeta(raw: unknown, path: string): CredentialMeta {
  const source = requireObject(raw, path);
  return {
    createdAt: requireNumber(source.createdAt, `${path}.createdAt`),
    updatedAt: requireNumber(source.updatedAt, `${path}.updatedAt`),
    passwordUpdatedAt: requireNumber(source.passwordUpdatedAt, `${path}.passwordUpdatedAt`),
    lastUsedAt: requireNullableNumber(source.lastUsedAt, `${path}.lastUsedAt`),
    useCount: requireNumber(source.useCount, `${path}.useCount`),
    expiresAt: requireNullableNumber(source.expiresAt, `${path}.expiresAt`),
    rotationIntervalDays: requireNullableNumber(
      source.rotationIntervalDays,
      `${path}.rotationIntervalDays`
    ),
    createdOrigin: parseOrigin(source.createdOrigin, `${path}.createdOrigin`),
  };
}

function parseHistory(raw: unknown, path: string): HistorySettings {
  const source = requireObject(raw, path);
  return {
    enabled: requireBoolean(source.enabled, `${path}.enabled`),
    maxVersions: requireNullableNumber(source.maxVersions, `${path}.maxVersions`),
    versions: requireArray(source.versions, `${path}.versions`).map((item, index) =>
      parseVersion(item, `${path}.versions[${index}]`)
    ),
  };
}

function parseVersion(raw: unknown, path: string): CredentialVersion {
  const source = requireObject(raw, path);
  return {
    versionNumber: requireNumber(source.versionNumber, `${path}.versionNumber`),
    savedAt: requireNumber(source.savedAt, `${path}.savedAt`),
    changedFields: requireArray(source.changedFields, `${path}.changedFields`).map((item, index) =>
      requireMember(item, `${path}.changedFields[${index}]`, VERSIONED_FIELDS)
    ),
    snapshot: parseSnapshot(source.snapshot, `${path}.snapshot`),
    origin: parseOrigin(source.origin, `${path}.origin`),
  };
}

function parseOrigin(raw: unknown, path: string): ChangeOrigin {
  const source = requireObject(raw, path);
  const origin: Mutable<ChangeOrigin> = {
    action: requireMember(source.action, `${path}.action`, HISTORY_ACTIONS),
  };

  for (const key of AUDIT_LEVEL_FIELDS.full) {
    // `action` is already read above, and is the one origin field that is not a plain
    // optional string — the `continue` is what narrows `key` for the assignment below.
    if (key === 'action') continue;
    const value = source[key];
    if (value === undefined) continue;
    origin[key] = requireString(value, `${path}.${key}`);
  }

  return origin;
}

function parseSnapshot(raw: unknown, path: string): VersionedValues {
  const source = requireObject(raw, path);
  const snapshot: Mutable<VersionedValues> = {};

  for (const field of VERSIONED_FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    const where = `${path}.${field}`;

    switch (field) {
      case 'title':
      case 'username':
      case 'email':
      case 'password':
      case 'notes':
        snapshot[field] = requireString(value, where);
        break;
      case 'urls':
      case 'tags':
        snapshot[field] = requireStringArray(value, where);
        break;
      case 'securityQuestions':
        snapshot.securityQuestions = parseQuestions(value, where);
        break;
      case 'custom':
        snapshot.custom = parseCustomFields(value, where);
        break;
      case 'icon':
        snapshot.icon = parseIcon(value, where);
        break;
      case 'favorite':
        snapshot.favorite = requireBoolean(value, where);
        break;
      case 'folderId':
        snapshot.folderId = requireNullableString(value, where);
        break;
      case 'expiresAt':
      case 'rotationIntervalDays':
        snapshot[field] = requireNullableNumber(value, where);
        break;
    }
  }

  return snapshot;
}
