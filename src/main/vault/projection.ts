// SPDX-License-Identifier: GPL-3.0-or-later
import {
  isCustomFieldValueSecret,
  type Credential,
  type CredentialProjection,
  type CustomFieldProjection,
  type SecurityQuestionProjection,
  type VersionProjection,
} from '@shared/model/credential.js';

/**
 * Builds the **safe projection** — the only view of a credential that may cross into the
 * renderer.
 *
 * This function is a security boundary, not a convenience mapper. Decision D13 rests
 * entirely on it: everything it copies is reachable by a compromised renderer, and
 * everything it omits is not.
 *
 * Two rules for editing this file:
 *
 * 1. **Build the projection field by field, explicitly.** Never spread the source record
 *    and delete secrets afterwards. A spread is additive by default — a field added to
 *    `Credential` later would silently start crossing the boundary, and nothing would
 *    fail. Explicit construction means a new field simply does not appear until someone
 *    deliberately adds it here, which is the correct default for a security boundary.
 *
 * 2. **A fact *about* a secret is not a secret.** `hasPassword` and `passwordLength` let
 *    the UI render a masked field of the right width and distinguish "not set" from
 *    "hidden" without carrying anything usable. Length is a very small leak, and it is a
 *    deliberate, bounded trade for a UI that does not lie about its own state.
 */

function projectCustomField(field: Credential['fields']['custom'][number]): CustomFieldProjection {
  const isSecret = isCustomFieldValueSecret(field);
  const base = {
    id: field.id,
    label: field.label,
    type: field.type,
    hidden: field.hidden,
    order: field.order,
    hasValue: field.value.length > 0,
    isSecret,
  };

  // The value is included only for fields that are neither a secret type nor user-hidden.
  return isSecret ? base : { ...base, value: field.value };
}

function projectSecurityQuestion(
  question: Credential['fields']['securityQuestions'][number]
): SecurityQuestionProjection {
  // The prompt is not secret — "your first pet's name" reveals nothing. The answer is a
  // credential and is treated exactly like a password.
  return {
    id: question.id,
    question: question.question,
    hasAnswer: question.answer.length > 0,
  };
}

function projectVersion(version: Credential['history']['versions'][number]): VersionProjection {
  // `snapshot` is deliberately dropped: it holds the *previous values* of changed fields,
  // which for a password change is an old password. History in the renderer is a timeline
  // of what changed and from where, never of what it used to be.
  return {
    versionNumber: version.versionNumber,
    savedAt: version.savedAt,
    changedFields: version.changedFields,
    origin: version.origin,
  };
}

export function toProjection(credential: Credential): CredentialProjection {
  return {
    id: credential.id,
    type: credential.type,
    title: credential.title,
    favorite: credential.favorite,
    folderId: credential.folderId,
    tags: credential.tags,
    icon: credential.icon,

    username: credential.fields.username,
    email: credential.fields.email,
    urls: credential.fields.urls,

    hasPassword: credential.fields.password.length > 0,
    passwordLength: credential.fields.password.length,
    hasNotes: credential.fields.notes.length > 0,
    notesLength: credential.fields.notes.length,

    securityQuestions: credential.fields.securityQuestions.map(projectSecurityQuestion),
    custom: credential.fields.custom.map(projectCustomField),
    attachments: credential.attachments,

    meta: credential.meta,
    historyEnabled: credential.history.enabled,
    historyCount: credential.history.versions.length,
    history: credential.history.versions.map(projectVersion),
    trashedAt: credential.trashedAt,
  };
}

export function toProjections(credentials: readonly Credential[]): CredentialProjection[] {
  return credentials.map(toProjection);
}
