// SPDX-License-Identifier: GPL-3.0-or-later
import {
  isCustomFieldValueSecret,
  type Credential,
  type CustomFieldProjection,
  type SecurityQuestionProjection,
  type VersionedField,
} from '@shared/model/credential.js';
import type { DiffSide, DiffValue, FieldDiffProjection } from '@shared/model/history.js';
import type { FieldDiff } from './versioning.js';

/**
 * Turns a diff into something the renderer may hold.
 *
 * `FieldDiff` carries the actual values on both sides, so a password change is *two*
 * passwords. It never crosses IPC as it stands. This is the second security boundary in the
 * codebase after `projection.ts`, and it follows the same two rules:
 *
 * **Built field by field, explicitly.** Never spread a `FieldDiff` and delete the values
 * afterwards — a spread is additive by default, so a field added later would silently start
 * crossing, and nothing would fail.
 *
 * **A fact about a secret is not a secret.** A password change reports the two lengths,
 * which is what lets the UI render `•••••••• → ••••••••••••` honestly rather than claiming a
 * change it cannot show. The values themselves are fetched one at a time, through the
 * broker, under the rate limit — `historic-password` and friends.
 */

function lengthOf(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

function projectQuestions(value: unknown): SecurityQuestionProjection[] {
  if (!Array.isArray(value)) return [];
  return (value as Credential['fields']['securityQuestions']).map((question) => ({
    id: question.id,
    question: question.question,
    hasAnswer: question.answer.length > 0,
  }));
}

function projectCustom(value: unknown): CustomFieldProjection[] {
  if (!Array.isArray(value)) return [];
  return (value as Credential['fields']['custom']).map((field) => {
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
    return isSecret ? base : { ...base, value: field.value };
  });
}

function projectSide(field: VersionedField, value: unknown): DiffSide {
  // Written as branches rather than a switch over `VersionedField`, because the honest
  // shape here is "these four are special, everything else is plain" — and an exhaustive
  // switch would list ten non-secret cases that all do the same thing, which reads as ten
  // decisions rather than one.
  if (field === 'password' || field === 'notes') {
    // The one thing that crosses about a secret: how long it was.
    return { kind: 'secret', length: lengthOf(value) };
  }
  if (field === 'securityQuestions') {
    return { kind: 'questions', questions: projectQuestions(value) };
  }
  if (field === 'custom') {
    return { kind: 'custom', fields: projectCustom(value) };
  }
  // Title, username, email, urls, tags, folderId, favorite, icon, expiresAt and
  // rotationIntervalDays are all non-secret by the classification in
  // `@shared/model/credential.js`, and safe to send as they are.
  return { kind: 'value', value: value as DiffValue };
}

export function toDiffProjection(diffs: readonly FieldDiff[]): FieldDiffProjection[] {
  return diffs.map((diff) => ({
    field: diff.field,
    isSecret: diff.isSecret,
    before: projectSide(diff.field, diff.before),
    after: projectSide(diff.field, diff.after),
  }));
}
