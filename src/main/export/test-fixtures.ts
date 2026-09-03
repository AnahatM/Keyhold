// SPDX-License-Identifier: GPL-3.0-or-later
import type { Credential } from '@shared/model/credential.js';
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
 * Fixtures for the export tests.
 *
 * Test support only — nothing in `src/main` outside a test imports this, the same
 * arrangement as `src/main/import/fixtures/load.ts`.
 *
 * Every value here is obviously fake: `example.com`, `hunter2`,
 * `correct-horse-battery-staple`. Nothing in this file is a credential, and nothing written
 * by these tests leaves the process — no fixture file is produced, because a `.csv` or
 * `.json` export sitting in the repo is exactly the artefact the project rule about
 * `tests/**\/fixtures` exists to make findable.
 */

/** A fixed, arbitrary "now". Every timestamp in the fixtures is relative to it. */
export const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

export interface RecordOverrides {
  readonly id?: string;
  readonly title?: string;
  readonly password?: string;
  readonly username?: string;
  readonly email?: string;
  readonly notes?: string;
  readonly urls?: readonly string[];
  readonly tags?: readonly string[];
  readonly folderId?: string | null;
  readonly trashedAt?: number | null;
  readonly favorite?: boolean;
}

/**
 * A record with something in every corner of the model: two URLs, a hidden custom field, a
 * TOTP seed, a security question, an attachment, an expiry, a non-default icon, and two
 * versions of history carrying full origins.
 *
 * One fixture rather than several small ones, because the property these tests care about
 * most is "nothing was quietly left behind", and that is only visible on a record that has
 * something in every field there is to leave behind.
 */
export function richRecord(overrides: RecordOverrides = {}): Credential {
  return {
    id: overrides.id ?? 'rec-1',
    type: 'login',
    title: overrides.title ?? 'Example Mail',
    favorite: overrides.favorite ?? true,
    folderId: overrides.folderId === undefined ? 'folder-child' : overrides.folderId,
    tags: [...(overrides.tags ?? ['work', 'email'])],
    icon: { kind: 'emoji', value: '📮' },
    fields: {
      username: overrides.username ?? 'ada',
      email: overrides.email ?? 'ada@example.com',
      password: overrides.password ?? 'correct-horse-battery-staple',
      urls: [...(overrides.urls ?? ['https://example.com/login', 'https://mail.example.com'])],
      securityQuestions: [
        { id: 'q-1', question: 'First pet’s name?', answer: 'Byron' },
        { id: 'q-2', question: 'City of birth?', answer: 'Basingstoke' },
      ],
      notes: overrides.notes ?? 'Recovery codes:\n1111-2222\n3333-4444',
      custom: [
        {
          id: 'cf-1',
          label: 'Account number',
          type: 'text',
          value: '4471-9902',
          hidden: false,
          order: 0,
        },
        { id: 'cf-2', label: 'Recovery PIN', type: 'pin', value: '9137', hidden: true, order: 1 },
        {
          id: 'cf-3',
          label: 'Authenticator',
          type: 'otp-secret',
          value: 'otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP',
          hidden: false,
          order: 2,
        },
      ],
    },
    attachments: [
      {
        id: '0123456789abcdef0123456789abcdef',
        name: 'recovery-kit.pdf',
        mime: 'application/pdf',
        size: 20_480,
        sha256: 'a'.repeat(64),
        addedAt: NOW - 30 * DAY,
      },
    ],
    meta: {
      createdAt: NOW - 400 * DAY,
      updatedAt: NOW - 10 * DAY,
      passwordUpdatedAt: NOW - 10 * DAY,
      lastUsedAt: NOW - DAY,
      useCount: 17,
      expiresAt: NOW + 90 * DAY,
      rotationIntervalDays: 180,
      createdOrigin: {
        action: 'create',
        deviceName: 'DESKTOP-A',
        platform: 'win32',
        appVersion: '0.1.0',
        osUser: 'ada',
        networkName: 'Home Wi-Fi',
        osRelease: '10.0.26200',
        localIp: '192.168.1.20',
      },
    },
    history: {
      enabled: true,
      maxVersions: 50,
      versions: [
        {
          versionNumber: 1,
          savedAt: NOW - 200 * DAY,
          changedFields: ['password', 'title'],
          snapshot: { password: 'hunter2', title: 'Example Webmail' },
          origin: { action: 'update', deviceName: 'LAPTOP-B', platform: 'darwin' },
        },
        {
          versionNumber: 2,
          savedAt: NOW - 10 * DAY,
          changedFields: ['custom', 'securityQuestions', 'tags', 'favorite', 'icon', 'folderId'],
          snapshot: {
            custom: [
              {
                id: 'cf-1',
                label: 'Account number',
                type: 'text',
                value: '0000-0000',
                hidden: false,
                order: 0,
              },
            ],
            securityQuestions: [{ id: 'q-1', question: 'First pet’s name?', answer: 'Ludo' }],
            tags: ['work'],
            favorite: false,
            icon: { kind: 'auto' },
            folderId: null,
          },
          origin: {
            action: 'restore',
            deviceName: 'DESKTOP-A',
            platform: 'win32',
            appVersion: '0.1.0',
            osUser: 'ada',
            networkName: 'Office',
            osRelease: '10.0.26200',
            localIp: '10.0.0.4',
          },
        },
      ],
    },
    trashedAt: overrides.trashedAt === undefined ? null : overrides.trashedAt,
  };
}

/** The plainest record the model allows, for asserting empty cells and absent keys. */
export function bareRecord(overrides: RecordOverrides = {}): Credential {
  return {
    id: overrides.id ?? 'rec-bare',
    type: 'login',
    title: overrides.title ?? 'Bare',
    favorite: overrides.favorite ?? false,
    folderId: overrides.folderId === undefined ? null : overrides.folderId,
    tags: [...(overrides.tags ?? [])],
    icon: { kind: 'auto' },
    fields: {
      username: overrides.username ?? '',
      email: overrides.email ?? '',
      password: overrides.password ?? '',
      urls: [...(overrides.urls ?? [])],
      securityQuestions: [],
      notes: overrides.notes ?? '',
      custom: [],
    },
    attachments: [],
    meta: {
      createdAt: NOW,
      updatedAt: NOW,
      passwordUpdatedAt: NOW,
      lastUsedAt: null,
      useCount: 0,
      expiresAt: null,
      rotationIntervalDays: null,
      createdOrigin: { action: 'create' },
    },
    history: { enabled: false, maxVersions: null, versions: [] },
    trashedAt: overrides.trashedAt === undefined ? null : overrides.trashedAt,
  };
}

export const FOLDERS: readonly Folder[] = [
  { id: 'folder-root', name: 'Personal', parentId: null, order: 0 },
  { id: 'folder-child', name: 'Mail', parentId: 'folder-root', order: 0 },
  { id: 'folder-empty', name: 'Archive', parentId: null, order: 1 },
];

export const TAGS: readonly Tag[] = [
  { id: 'tag-1', name: 'work', colour: 'accent-blue' },
  { id: 'tag-2', name: 'email', colour: 'accent-green' },
  { id: 'tag-3', name: 'unused', colour: 'accent-red' },
];

/**
 * Two named queries, so the lossless round-trip has something to lose.
 *
 * A fixture with an empty array would let a writer that never serialises saved searches, and
 * a reader that never parses them, agree perfectly — which is exactly the shape of test that
 * passes while the feature does nothing.
 */
const SAVED_SEARCHES: readonly SavedSearch[] = [
  {
    id: 'search-weak',
    name: 'Needs attention',
    query: 'is:weak',
    order: 0,
    updatedAt: 1_700_000_000_000,
  },
  {
    id: 'search-bank',
    name: 'Banking',
    query: 'folder:Finance has:totp',
    order: 1,
    updatedAt: 1_700_000_001_000,
  },
];

export function buildDocument(
  records: readonly Credential[],
  settings: VaultSettings = DEFAULT_VAULT_SETTINGS
): VaultDocument {
  return {
    documentVersion: VAULT_DOCUMENT_VERSION,
    records: [...records],
    folders: [...FOLDERS],
    tags: [...TAGS],
    savedSearches: [...SAVED_SEARCHES],
    settings,
  };
}
