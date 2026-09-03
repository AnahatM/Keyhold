// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  AttachmentMeta,
  ChangeOrigin,
  Credential,
  CredentialIcon,
  CredentialVersion,
  CustomField,
  HistoryAction,
  SecurityQuestion,
  VersionedField,
  VersionedValues,
} from '@shared/model/credential.js';
import {
  DEFAULT_VAULT_SETTINGS,
  VAULT_DOCUMENT_VERSION,
  type Folder,
  type Tag,
  type VaultDocument,
  type VaultSettings,
} from '@shared/model/vault-document.js';
import type { SavedSearch } from '@shared/model/saved-search.js';

/**
 * Fixtures for the merge tests.
 *
 * Not a `.test.ts` file on purpose: five test files build the same records, and five copies of
 * a record builder is five places for "a record that breaks nothing" to quietly mean five
 * different things. `src/main/export/test-fixtures.ts` sets the precedent.
 *
 * Everything here is deterministic. No clock, no randomness, no ids that change between runs —
 * a merge is a pure function and its tests have to be able to assert byte-identical output.
 */

export const NOW = 1_800_000_000_000;
export const DAY = 86_400_000;

export function origin(action: HistoryAction = 'update', deviceName = 'fixture'): ChangeOrigin {
  return { action, deviceName, platform: 'test', appVersion: '0.0.0' };
}

export interface VersionInput {
  readonly versionNumber: number;
  readonly savedAt: number;
  readonly snapshot: VersionedValues;
  readonly origin?: ChangeOrigin;
}

/** A version whose `changedFields` is derived from its snapshot, so the invariants hold. */
export function version(input: VersionInput): CredentialVersion {
  return {
    versionNumber: input.versionNumber,
    savedAt: input.savedAt,
    changedFields: Object.keys(input.snapshot) as VersionedField[],
    snapshot: input.snapshot,
    origin: input.origin ?? origin(),
  };
}

export interface RecordInput {
  readonly id: string;
  readonly title?: string;
  readonly username?: string;
  readonly email?: string;
  readonly password?: string;
  readonly notes?: string;
  readonly urls?: readonly string[];
  readonly tags?: readonly string[];
  readonly folderId?: string | null;
  readonly favorite?: boolean;
  readonly icon?: CredentialIcon;
  readonly custom?: readonly CustomField[];
  readonly securityQuestions?: readonly SecurityQuestion[];
  readonly attachments?: readonly AttachmentMeta[];
  readonly trashedAt?: number | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly passwordUpdatedAt?: number;
  readonly lastUsedAt?: number | null;
  readonly useCount?: number;
  readonly expiresAt?: number | null;
  readonly rotationIntervalDays?: number | null;
  readonly createdOrigin?: ChangeOrigin;
  readonly historyEnabled?: boolean;
  readonly historyMaxVersions?: number | null;
  readonly versions?: readonly CredentialVersion[];
}

export function record(input: RecordInput): Credential {
  return {
    id: input.id,
    type: 'login',
    title: input.title ?? `Record ${input.id}`,
    favorite: input.favorite ?? false,
    folderId: input.folderId ?? null,
    tags: input.tags ?? [],
    icon: input.icon ?? { kind: 'auto' },
    fields: {
      username: input.username ?? 'user',
      email: input.email ?? '',
      password: input.password ?? 'correct horse battery staple',
      urls: input.urls ?? ['https://example.com'],
      securityQuestions: input.securityQuestions ?? [],
      notes: input.notes ?? '',
      custom: input.custom ?? [],
    },
    attachments: input.attachments ?? [],
    meta: {
      createdAt: input.createdAt ?? NOW - 100 * DAY,
      updatedAt: input.updatedAt ?? NOW - 10 * DAY,
      passwordUpdatedAt: input.passwordUpdatedAt ?? NOW - 10 * DAY,
      lastUsedAt: input.lastUsedAt ?? null,
      useCount: input.useCount ?? 0,
      expiresAt: input.expiresAt ?? null,
      rotationIntervalDays: input.rotationIntervalDays ?? null,
      createdOrigin: input.createdOrigin ?? origin('create'),
    },
    history: {
      enabled: input.historyEnabled ?? true,
      maxVersions: input.historyMaxVersions === undefined ? 50 : input.historyMaxVersions,
      versions: input.versions ?? [],
    },
    trashedAt: input.trashedAt ?? null,
  };
}

/** A shallow edit of a record, so a test can say "the same record, with a different title". */
export function edited(base: Credential, input: Omit<RecordInput, 'id'>): Credential {
  return record({ ...describe(base), ...input, id: base.id });
}

/** The inverse of `record` for the fields `edited` needs to carry forward. */
function describe(credential: Credential): RecordInput {
  return {
    id: credential.id,
    title: credential.title,
    username: credential.fields.username,
    email: credential.fields.email,
    password: credential.fields.password,
    notes: credential.fields.notes,
    urls: credential.fields.urls,
    tags: credential.tags,
    folderId: credential.folderId,
    favorite: credential.favorite,
    icon: credential.icon,
    custom: credential.fields.custom,
    securityQuestions: credential.fields.securityQuestions,
    attachments: credential.attachments,
    trashedAt: credential.trashedAt,
    createdAt: credential.meta.createdAt,
    updatedAt: credential.meta.updatedAt,
    passwordUpdatedAt: credential.meta.passwordUpdatedAt,
    lastUsedAt: credential.meta.lastUsedAt,
    useCount: credential.meta.useCount,
    expiresAt: credential.meta.expiresAt,
    rotationIntervalDays: credential.meta.rotationIntervalDays,
    createdOrigin: credential.meta.createdOrigin,
    historyEnabled: credential.history.enabled,
    historyMaxVersions: credential.history.maxVersions,
    versions: credential.history.versions,
  };
}

export interface DocumentInput {
  readonly records?: readonly Credential[];
  readonly folders?: readonly Folder[];
  readonly tags?: readonly Tag[];
  readonly savedSearches?: readonly SavedSearch[];
  readonly settings?: VaultSettings;
}

export function doc(input: DocumentInput = {}): VaultDocument {
  return {
    documentVersion: VAULT_DOCUMENT_VERSION,
    records: input.records ?? [],
    folders: input.folders ?? [],
    tags: input.tags ?? [],
    savedSearches: input.savedSearches ?? [],
    settings: input.settings ?? DEFAULT_VAULT_SETTINGS,
  };
}

export function folder(id: string, name = id, parentId: string | null = null, order = 0): Folder {
  return { id, name, parentId, order };
}

export function paletteTag(id: string, name = id, colour = '--kh-tag-blue'): Tag {
  return { id, name, colour };
}

export function customField(
  id: string,
  label: string,
  value: string,
  overrides: { type?: CustomField['type']; hidden?: boolean; order?: number } = {}
): CustomField {
  return {
    id,
    label,
    type: overrides.type ?? 'text',
    value,
    hidden: overrides.hidden ?? false,
    order: overrides.order ?? 0,
  };
}

export function question(id: string, prompt: string, answer: string): SecurityQuestion {
  return { id, question: prompt, answer };
}

export function attachment(id: string, name = `${id}.pdf`): AttachmentMeta {
  return { id, name, mime: 'application/pdf', size: 1024, sha256: id.repeat(2), addedAt: NOW };
}

/** The options every test passes unless it is testing the options themselves. */
export const MERGE_OPTIONS = { now: NOW } as const;

/** A saved search, with everything defaulted so a test names only what it is about. */
export function savedSearch(id: string, overrides: Partial<SavedSearch> = {}): SavedSearch {
  return { id, name: id, query: `tag:${id}`, order: 0, updatedAt: NOW, ...overrides };
}
