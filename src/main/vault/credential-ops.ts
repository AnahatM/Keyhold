// SPDX-License-Identifier: GPL-3.0-or-later
import {
  CUSTOM_FIELD_TYPES,
  type ChangeOrigin,
  type Credential,
  type CredentialFields,
  type CustomField,
  type CustomFieldType,
  type HistoryAction,
  type SecurityQuestion,
} from '@shared/model/credential.js';
import type { VaultDocument, VaultSettings } from '@shared/model/vault-document.js';
import { malformed } from '../crypto/errors.js';

/**
 * Credential operations, as **pure functions over a document**.
 *
 * Nothing here touches a key, a file, or a clock it did not receive. That is deliberate:
 * the rules about what a valid record is, what a change to one means, and what deletion
 * does are the part most likely to acquire a subtle bug, and keeping them free of I/O is
 * what lets every one of them be tested directly rather than through an unlocked vault.
 *
 * `VaultService` composes these and marks itself dirty; it does not reimplement them.
 *
 * Everything returns a **new** document. Mutating in place would make undo — which every
 * destructive action in this app offers — a matter of carefully reversing each field,
 * rather than simply keeping the previous value.
 */

// ── Validation ───────────────────────────────────────────────────────────────

/** Field values that a user could plausibly paste, capped so one record cannot bloat a vault. */
const MAX_TITLE_LENGTH = 400;
const MAX_FIELD_LENGTH = 65_536;
const MAX_NOTES_LENGTH = 1_048_576;
const MAX_URLS = 32;
const MAX_CUSTOM_FIELDS = 128;
const MAX_SECURITY_QUESTIONS = 32;
const MAX_TAGS = 64;

function requireLength(value: string, limit: number, what: string): string {
  if (value.length > limit) {
    throw malformed(`${what} is longer than the ${limit}-character limit`);
  }
  return value;
}

export function isCustomFieldType(value: unknown): value is CustomFieldType {
  return typeof value === 'string' && (CUSTOM_FIELD_TYPES as readonly string[]).includes(value);
}

/**
 * Checks a record before it enters the document.
 *
 * Runs on every create and update, not only on import. A record with duplicate custom-field
 * ids looks fine until someone reveals one and gets the other's value — and the reveal path
 * addresses fields *by id*, so a duplicate is a correctness bug with a security shape.
 */
export function assertValidCredential(credential: Credential): void {
  requireLength(credential.title, MAX_TITLE_LENGTH, 'The title');
  requireLength(credential.fields.username, MAX_FIELD_LENGTH, 'The username');
  requireLength(credential.fields.email, MAX_FIELD_LENGTH, 'The email');
  requireLength(credential.fields.password, MAX_FIELD_LENGTH, 'The password');
  requireLength(credential.fields.notes, MAX_NOTES_LENGTH, 'The notes');

  if (credential.fields.urls.length > MAX_URLS) {
    throw malformed(`a record may have at most ${MAX_URLS} URLs`);
  }
  if (credential.tags.length > MAX_TAGS) {
    throw malformed(`a record may have at most ${MAX_TAGS} tags`);
  }
  if (credential.fields.custom.length > MAX_CUSTOM_FIELDS) {
    throw malformed(`a record may have at most ${MAX_CUSTOM_FIELDS} custom fields`);
  }
  if (credential.fields.securityQuestions.length > MAX_SECURITY_QUESTIONS) {
    throw malformed(`a record may have at most ${MAX_SECURITY_QUESTIONS} security questions`);
  }

  const fieldIds = new Set<string>();
  for (const field of credential.fields.custom) {
    if (!isCustomFieldType(field.type)) {
      // TypeScript narrows `field.type` to `never` here because the model declares it as a
      // union — but the value came from a file or from IPC, where the type system
      // guarantees nothing. The cast states that runtime reality.
      throw malformed(`unknown custom field type "${String(field.type)}"`);
    }
    if (fieldIds.has(field.id)) {
      // Reveal addresses fields by id, so a duplicate would silently return the wrong value.
      throw malformed('two custom fields share an id');
    }
    fieldIds.add(field.id);
    requireLength(field.value, MAX_FIELD_LENGTH, `Custom field "${field.label}"`);
  }

  const questionIds = new Set<string>();
  for (const question of credential.fields.securityQuestions) {
    if (questionIds.has(question.id)) {
      throw malformed('two security questions share an id');
    }
    questionIds.add(question.id);
    requireLength(question.answer, MAX_FIELD_LENGTH, 'A security answer');
  }
}

// ── Construction ─────────────────────────────────────────────────────────────

/**
 * Every field is `| undefined` as well as optional.
 *
 * Under `exactOptionalPropertyTypes` those are different types, and callers legitimately
 * build these objects by conditional assignment. Accepting both here rather than forcing
 * every caller to construct exactly-absent keys keeps the awkwardness in one place.
 */
export interface NewCredentialInput {
  readonly title: string;
  /** How this record came to exist. `'import'` for importer output; `'create'` otherwise. */
  readonly action?: HistoryAction | undefined;
  readonly username?: string | undefined;
  readonly email?: string | undefined;
  readonly password?: string | undefined;
  readonly urls?: readonly string[] | undefined;
  readonly notes?: string | undefined;
  readonly securityQuestions?: readonly SecurityQuestion[] | undefined;
  readonly custom?: readonly CustomField[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly folderId?: string | null | undefined;
  readonly favorite?: boolean | undefined;
}

export interface OpsContext {
  /** UUID v7 — time-sortable, so creation order is free. */
  readonly newId: () => string;
  readonly now: () => number;
  readonly settings: VaultSettings;
  /**
   * Captures the device and network provenance for a change.
   *
   * A function rather than a value so nothing is read from the machine unless a record is
   * actually created, and so the privacy level in `settings` is honoured at the moment of
   * capture rather than whenever the context happened to be built.
   *
   * Defaults to recording the verb and nothing else. That default is deliberate: an
   * embedding that forgets to wire the real capture records *less* than it could, never
   * more than the user asked for.
   */
  readonly captureOrigin?: ((action: HistoryAction) => ChangeOrigin) | undefined;
}

/** The origin for `action`, or the verb alone when no capture is wired in. */
export function originFor(context: OpsContext, action: HistoryAction): ChangeOrigin {
  return context.captureOrigin?.(action) ?? { action };
}

export function buildCredential(input: NewCredentialInput, context: OpsContext): Credential {
  const now = context.now();

  const credential: Credential = {
    id: context.newId(),
    type: 'login',
    title: input.title.trim(),
    favorite: input.favorite ?? false,
    folderId: input.folderId ?? null,
    tags: normaliseTags(input.tags ?? []),
    icon: { kind: 'auto' },
    fields: {
      username: input.username ?? '',
      email: input.email ?? '',
      password: input.password ?? '',
      urls: (input.urls ?? []).map((url) => url.trim()).filter((url) => url !== ''),
      securityQuestions: input.securityQuestions ?? [],
      notes: input.notes ?? '',
      custom: sortCustomFields(input.custom ?? []),
    },
    attachments: [],
    meta: {
      createdAt: now,
      updatedAt: now,
      passwordUpdatedAt: now,
      lastUsedAt: null,
      useCount: 0,
      expiresAt: null,
      rotationIntervalDays: null,
      createdOrigin: originFor(context, input.action ?? 'create'),
    },
    history: {
      // The per-credential checkbox, defaulting from vault settings. Recorded on the record
      // rather than read from settings at display time, so changing the default later does
      // not silently start or stop recording history for existing records.
      enabled: context.settings.historyEnabledByDefault,
      maxVersions: context.settings.historyMaxVersions,
      versions: [],
    },
    trashedAt: null,
  };

  assertValidCredential(credential);
  return credential;
}

/** Tags are case-insensitively unique and trimmed; order is preserved. */
export function normaliseTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === '') continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

/** Custom fields are stored in display order, with `order` renumbered contiguously. */
export function sortCustomFields(fields: readonly CustomField[]): CustomField[] {
  return [...fields]
    .sort((a, b) => a.order - b.order)
    .map((field, index) => ({ ...field, order: index }));
}

// ── Updating ─────────────────────────────────────────────────────────────────

/** See the note on `NewCredentialInput` for why every field admits `undefined`. */
export interface CredentialPatch {
  readonly title?: string | undefined;
  readonly favorite?: boolean | undefined;
  readonly folderId?: string | null | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly icon?: Credential['icon'] | undefined;
  readonly fields?: FieldsPatch | undefined;
  readonly meta?:
    | { expiresAt?: number | null | undefined; rotationIntervalDays?: number | null | undefined }
    | undefined;
  readonly history?:
    { enabled?: boolean | undefined; maxVersions?: number | null | undefined } | undefined;
}

export type FieldsPatch = {
  readonly [K in keyof CredentialFields]?: CredentialFields[K] | undefined;
};

export interface UpdateResult {
  readonly credential: Credential;
  /** Field names that actually changed. Empty when the patch was a no-op. */
  readonly changedFields: readonly string[];
}

/**
 * Applies a patch, returning the new record and what actually changed.
 *
 * The changed-field list is the reason this is not a plain spread. Phase 6's history needs
 * to know precisely which fields moved — storing a full snapshot per edit would grow
 * without bound on a frequently-edited record — and "which fields changed" is a question
 * only the code doing the merge can answer cheaply.
 *
 * **A patch that changes nothing returns an empty list**, so callers can skip the save
 * entirely. Without that, opening a record and closing it would bump `updatedAt`, create a
 * history version, and dirty the vault, for no user-visible change at all.
 */
export function applyPatch(
  credential: Credential,
  patch: CredentialPatch,
  context: OpsContext
): UpdateResult {
  const changed: string[] = [];

  const title = patch.title === undefined ? credential.title : patch.title.trim();
  if (title !== credential.title) changed.push('title');

  const favorite = patch.favorite ?? credential.favorite;
  if (favorite !== credential.favorite) changed.push('favorite');

  const folderId = patch.folderId === undefined ? credential.folderId : patch.folderId;
  if (folderId !== credential.folderId) changed.push('folderId');

  const tags = patch.tags === undefined ? credential.tags : normaliseTags(patch.tags);
  if (!sameStrings(tags, credential.tags)) changed.push('tags');

  const icon = patch.icon ?? credential.icon;
  if (icon.kind !== credential.icon.kind || icon.value !== credential.icon.value) {
    changed.push('icon');
  }

  const fields = mergeFields(credential.fields, patch.fields, changed);

  const historyEnabled = patch.history?.enabled ?? credential.history.enabled;
  const historyMax =
    patch.history?.maxVersions === undefined
      ? credential.history.maxVersions
      : patch.history.maxVersions;
  if (historyEnabled !== credential.history.enabled) changed.push('historyEnabled');

  const expiresAt =
    patch.meta?.expiresAt === undefined ? credential.meta.expiresAt : patch.meta.expiresAt;
  const rotationIntervalDays =
    patch.meta?.rotationIntervalDays === undefined
      ? credential.meta.rotationIntervalDays
      : patch.meta.rotationIntervalDays;
  if (expiresAt !== credential.meta.expiresAt) changed.push('expiresAt');
  if (rotationIntervalDays !== credential.meta.rotationIntervalDays) {
    changed.push('rotationIntervalDays');
  }

  if (changed.length === 0) {
    return { credential, changedFields: [] };
  }

  const now = context.now();
  const updated: Credential = {
    ...credential,
    title,
    favorite,
    folderId,
    tags,
    icon,
    fields,
    meta: {
      ...credential.meta,
      updatedAt: now,
      // Tracked separately from `updatedAt` because the health dashboard asks "how old is
      // this PASSWORD", and renaming a record must not make an ancient password look fresh.
      passwordUpdatedAt: changed.includes('password') ? now : credential.meta.passwordUpdatedAt,
      expiresAt,
      rotationIntervalDays,
    },
    history: { ...credential.history, enabled: historyEnabled, maxVersions: historyMax },
  };

  assertValidCredential(updated);
  return { credential: updated, changedFields: changed };
}

function mergeFields(
  current: CredentialFields,
  patch: FieldsPatch | undefined,
  changed: string[]
): CredentialFields {
  if (patch === undefined) return current;

  const username = patch.username ?? current.username;
  if (username !== current.username) changed.push('username');

  const email = patch.email ?? current.email;
  if (email !== current.email) changed.push('email');

  const password = patch.password ?? current.password;
  if (password !== current.password) changed.push('password');

  const urls =
    patch.urls === undefined
      ? current.urls
      : patch.urls.map((url) => url.trim()).filter((url) => url !== '');
  if (!sameStrings(urls, current.urls)) changed.push('urls');

  const notes = patch.notes ?? current.notes;
  if (notes !== current.notes) changed.push('notes');

  const securityQuestions = patch.securityQuestions ?? current.securityQuestions;
  if (!sameQuestions(securityQuestions, current.securityQuestions)) {
    changed.push('securityQuestions');
  }

  const custom = patch.custom === undefined ? current.custom : sortCustomFields(patch.custom);
  if (!sameCustomFields(custom, current.custom)) changed.push('custom');

  return { username, email, password, urls, securityQuestions, notes, custom };
}

// ── Document-level operations ────────────────────────────────────────────────

export function addCredential(document: VaultDocument, credential: Credential): VaultDocument {
  if (document.records.some((record) => record.id === credential.id)) {
    throw malformed('a record with that id already exists');
  }
  return { ...document, records: [...document.records, credential] };
}

export function replaceCredential(document: VaultDocument, credential: Credential): VaultDocument {
  return {
    ...document,
    records: document.records.map((record) => (record.id === credential.id ? credential : record)),
  };
}

export function findCredential(document: VaultDocument, id: string): Credential | null {
  return document.records.find((record) => record.id === id) ?? null;
}

/**
 * Soft-deletes: sets `trashedAt` rather than removing the record.
 *
 * A tombstone, not a deletion. Two reasons, and the second is the load-bearing one:
 * the user gets a Trash they can restore from, and **sync gets a marker that says "this
 * was deleted"**. Without the marker, a merge with a device that still has the record
 * would faithfully resurrect it — which is not a hypothetical, it is what happens by
 * default in any last-writer-wins scheme.
 */
export function trashCredential(document: VaultDocument, id: string, now: number): VaultDocument {
  const record = findCredential(document, id);
  if (record === null) throw malformed('no such record');
  if (record.trashedAt !== null) return document;

  return replaceCredential(document, { ...record, trashedAt: now });
}

export function restoreCredential(document: VaultDocument, id: string): VaultDocument {
  const record = findCredential(document, id);
  if (record === null) throw malformed('no such record');
  if (record.trashedAt === null) return document;

  return replaceCredential(document, { ...record, trashedAt: null });
}

/** Permanent deletion. The only operation in this file that actually loses data. */
export function purgeCredential(document: VaultDocument, id: string): VaultDocument {
  return { ...document, records: document.records.filter((record) => record.id !== id) };
}

/**
 * Removes trashed records past the retention window.
 *
 * Runs on save rather than on a timer, so a vault that is never opened never loses
 * anything — retention measured against wall-clock time while the app was closed would
 * mean opening a vault after a long break silently purges a trash the user never saw.
 */
export function purgeExpiredTrash(document: VaultDocument, now: number): VaultDocument {
  const days = document.settings.trashRetentionDays;
  if (days === null) return document;

  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return {
    ...document,
    records: document.records.filter(
      (record) => record.trashedAt === null || record.trashedAt > cutoff
    ),
  };
}

/**
 * Copies a record under a new identity.
 *
 * Every id is regenerated — the record's own, and each custom field's and security
 * question's. Sharing ids with the original would make the two records' fields
 * indistinguishable to the reveal path, which addresses them by id.
 *
 * History is deliberately NOT copied: it belongs to the original record's past, and
 * carrying it over would attribute edits to a record that did not exist when they happened.
 */
export function duplicateCredential(credential: Credential, context: OpsContext): Credential {
  const now = context.now();

  const copy: Credential = {
    ...credential,
    id: context.newId(),
    title: `${credential.title} (copy)`,
    fields: {
      ...credential.fields,
      custom: credential.fields.custom.map((field) => ({ ...field, id: context.newId() })),
      securityQuestions: credential.fields.securityQuestions.map((question) => ({
        ...question,
        id: context.newId(),
      })),
    },
    // Attachments are not copied: the chunks belong to the original, and duplicating a
    // 20 MB PDF because someone wanted a second login is not what they asked for.
    attachments: [],
    meta: {
      ...credential.meta,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      useCount: 0,
      // Captured fresh: the copy was created here and now, not wherever the original was.
      createdOrigin: originFor(context, 'create'),
    },
    history: { ...credential.history, versions: [] },
    trashedAt: null,
  };

  assertValidCredential(copy);
  return copy;
}

/** Records a use, for "recently used" and sort-by-frequency. */
export function recordUse(credential: Credential, now: number): Credential {
  return {
    ...credential,
    meta: { ...credential.meta, lastUsedAt: now, useCount: credential.meta.useCount + 1 },
  };
}

// ── Comparison helpers ───────────────────────────────────────────────────────

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameQuestions(a: readonly SecurityQuestion[], b: readonly SecurityQuestion[]): boolean {
  return (
    a.length === b.length &&
    a.every((question, index) => {
      const other = b[index];
      return (
        other?.id === question.id &&
        other.question === question.question &&
        other.answer === question.answer
      );
    })
  );
}

function sameCustomFields(a: readonly CustomField[], b: readonly CustomField[]): boolean {
  return (
    a.length === b.length &&
    a.every((field, index) => {
      const other = b[index];
      return (
        other?.id === field.id &&
        other.label === field.label &&
        other.type === field.type &&
        other.value === field.value &&
        other.hidden === field.hidden &&
        other.order === field.order
      );
    })
  );
}
