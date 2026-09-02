// SPDX-License-Identifier: GPL-3.0-or-later
import {
  CUSTOM_FIELD_TYPES,
  type CustomFieldType,
  type SecurityQuestion,
} from '../model/credential.js';
import type { CredentialEdit, CredentialInput, CustomFieldInput } from './api.js';
import {
  IpcValidationError,
  requireBoolean,
  requireId,
  requireNonEmptyString,
  requireString,
} from './validation.js';

/**
 * Runtime validation for credential payloads.
 *
 * The largest and most structured thing the renderer sends, and therefore the one where
 * "the types say it is fine" is least true — every field arrives as `unknown` at runtime,
 * and a record that gets past this goes straight into the user's vault.
 *
 * Three properties this file exists to guarantee:
 *
 * **Every object is rebuilt field by field**, never spread. A spread would carry whatever
 * extra properties the payload happened to contain into a record that is then encrypted
 * and stored forever.
 *
 * **Fields are assigned, not conditionally spread.** Under `exactOptionalPropertyTypes` a
 * spread of `{}` widens every optional field to include `undefined`, which is a genuinely
 * different type from "absent" — and the distinction matters here, because absent means
 * "leave it alone" and an empty string means "clear it".
 *
 * **Arrays are capped here as well as in `credential-ops`.** That layer caps them so a
 * vault is not bloated; this one caps them so ten thousand custom fields arriving over IPC
 * are rejected before anything tries to validate them one at a time.
 */

const MAX_URLS = 32;
const MAX_TAGS = 64;
const MAX_CUSTOM_FIELDS = 128;
const MAX_SECURITY_QUESTIONS = 32;

/** Mutable, all-optional view of a shape, for building one field at a time. */
type Draft<T> = { -readonly [K in keyof T]?: T[K] };

function requireArray(channel: string, value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new IpcValidationError(channel, `${name} must be an array`);
  if (value.length > max) {
    throw new IpcValidationError(channel, `${name} has more than ${max} entries`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireCustomFieldType(channel: string, value: unknown): CustomFieldType {
  if (typeof value !== 'string' || !(CUSTOM_FIELD_TYPES as readonly string[]).includes(value)) {
    // Rejected rather than defaulted to 'text'. The type decides whether a value is treated
    // as secret, so guessing it wrong would put a password into the safe projection.
    throw new IpcValidationError(channel, 'a custom field has an unknown type');
  }
  return value as CustomFieldType;
}

function requireOrder(channel: string, value: unknown, index: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new IpcValidationError(channel, `custom[${index}].order is not a valid position`);
  }
  return value;
}

function parseCustomFields(channel: string, value: unknown): CustomFieldInput[] {
  return requireArray(channel, value, 'custom', MAX_CUSTOM_FIELDS).map((entry, index) => {
    if (!isObject(entry)) {
      throw new IpcValidationError(channel, `custom field ${index} is not an object`);
    }
    return {
      id: requireId(channel, entry.id, `custom[${index}].id`),
      label: requireString(channel, entry.label, `custom[${index}].label`),
      type: requireCustomFieldType(channel, entry.type),
      value: requireString(channel, entry.value, `custom[${index}].value`),
      hidden: requireBoolean(channel, entry.hidden, `custom[${index}].hidden`),
      order: requireOrder(channel, entry.order, index),
    };
  });
}

function parseSecurityQuestions(channel: string, value: unknown): SecurityQuestion[] {
  return requireArray(channel, value, 'securityQuestions', MAX_SECURITY_QUESTIONS).map(
    (entry, index) => {
      if (!isObject(entry)) {
        throw new IpcValidationError(channel, `security question ${index} is not an object`);
      }
      return {
        id: requireId(channel, entry.id, `securityQuestions[${index}].id`),
        question: requireString(channel, entry.question, `securityQuestions[${index}].question`),
        answer: requireString(channel, entry.answer, `securityQuestions[${index}].answer`),
      };
    }
  );
}

function parseUrls(channel: string, value: unknown): string[] {
  return requireArray(channel, value, 'urls', MAX_URLS).map((url, index) =>
    requireString(channel, url, `urls[${index}]`)
  );
}

function parseTags(channel: string, value: unknown): string[] {
  return requireArray(channel, value, 'tags', MAX_TAGS).map((tag, index) =>
    requireString(channel, tag, `tags[${index}]`)
  );
}

const ICON_KINDS = ['auto', 'letter', 'emoji', 'custom'] as const;

function parseIcon(channel: string, value: unknown): NonNullable<CredentialEdit['icon']> {
  if (!isObject(value)) throw new IpcValidationError(channel, 'icon must be an object');

  const kind = value.kind;
  if (typeof kind !== 'string' || !(ICON_KINDS as readonly string[]).includes(kind)) {
    throw new IpcValidationError(channel, 'icon.kind is not a known kind');
  }

  const icon: { kind: (typeof ICON_KINDS)[number]; value?: string } = {
    kind: kind as (typeof ICON_KINDS)[number],
  };
  if (value.value !== undefined) icon.value = requireString(channel, value.value, 'icon.value');
  return icon;
}

function parseNullableTimestamp(channel: string, value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new IpcValidationError(channel, `${name} is not a valid timestamp`);
  }
  return value;
}

function parseNullableDays(channel: string, value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 3_650) {
    throw new IpcValidationError(channel, `${name} must be between 1 and 3650 days`);
  }
  return value;
}

export function requireCredentialInput(channel: string, value: unknown): CredentialInput {
  if (!isObject(value)) throw new IpcValidationError(channel, 'the record must be an object');

  const input: Draft<CredentialInput> & { title: string } = {
    title: requireNonEmptyString(channel, value.title, 'title'),
  };

  if (value.username !== undefined) {
    input.username = requireString(channel, value.username, 'username');
  }
  if (value.email !== undefined) input.email = requireString(channel, value.email, 'email');
  if (value.password !== undefined) {
    input.password = requireString(channel, value.password, 'password');
  }
  if (value.urls !== undefined) input.urls = parseUrls(channel, value.urls);
  if (value.notes !== undefined) input.notes = requireString(channel, value.notes, 'notes');
  if (value.securityQuestions !== undefined) {
    input.securityQuestions = parseSecurityQuestions(channel, value.securityQuestions);
  }
  if (value.custom !== undefined) input.custom = parseCustomFields(channel, value.custom);
  if (value.tags !== undefined) input.tags = parseTags(channel, value.tags);
  if (value.folderId !== undefined && value.folderId !== null) {
    input.folderId = requireId(channel, value.folderId, 'folderId');
  }
  if (value.favorite !== undefined) {
    input.favorite = requireBoolean(channel, value.favorite, 'favorite');
  }

  return input;
}

/**
 * Validates an edit.
 *
 * Distinct from `requireCredentialInput` because **absent and empty mean different things
 * here**: an absent field is "leave it alone", an empty string is "clear it". Reusing the
 * create validator would make every edit a full replacement, and clearing a field would be
 * indistinguishable from not touching it.
 */
export function requireCredentialEdit(channel: string, value: unknown): CredentialEdit {
  if (!isObject(value)) throw new IpcValidationError(channel, 'the edit must be an object');

  const edit: Draft<CredentialEdit> = {};

  if (value.title !== undefined) edit.title = requireNonEmptyString(channel, value.title, 'title');
  if (value.username !== undefined) {
    edit.username = requireString(channel, value.username, 'username');
  }
  if (value.email !== undefined) edit.email = requireString(channel, value.email, 'email');
  if (value.password !== undefined) {
    edit.password = requireString(channel, value.password, 'password');
  }
  if (value.urls !== undefined) edit.urls = parseUrls(channel, value.urls);
  if (value.notes !== undefined) edit.notes = requireString(channel, value.notes, 'notes');
  if (value.securityQuestions !== undefined) {
    edit.securityQuestions = parseSecurityQuestions(channel, value.securityQuestions);
  }
  if (value.custom !== undefined) edit.custom = parseCustomFields(channel, value.custom);
  if (value.tags !== undefined) edit.tags = parseTags(channel, value.tags);

  // `null` is meaningful here — it moves a record out of every folder — while `undefined`
  // still means "leave it alone".
  if (value.folderId !== undefined) {
    edit.folderId = value.folderId === null ? null : requireId(channel, value.folderId, 'folderId');
  }
  if (value.favorite !== undefined) {
    edit.favorite = requireBoolean(channel, value.favorite, 'favorite');
  }
  if (value.icon !== undefined) edit.icon = parseIcon(channel, value.icon);
  if (value.expiresAt !== undefined) {
    edit.expiresAt = parseNullableTimestamp(channel, value.expiresAt, 'expiresAt');
  }
  if (value.rotationIntervalDays !== undefined) {
    edit.rotationIntervalDays = parseNullableDays(
      channel,
      value.rotationIntervalDays,
      'rotationIntervalDays'
    );
  }
  if (value.historyEnabled !== undefined) {
    edit.historyEnabled = requireBoolean(channel, value.historyEnabled, 'historyEnabled');
  }

  return edit;
}
