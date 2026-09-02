// SPDX-License-Identifier: GPL-3.0-or-later
import type { CredentialProjection } from '@shared/model/credential.js';
import type { Folder, Tag } from '@shared/model/vault-document.js';

/**
 * Fixture builders for the organisation tests.
 *
 * One place that knows the full shape of a `CredentialProjection`, so a field added to the
 * model breaks here once rather than in every test file — and so no test accidentally
 * asserts against a projection that is missing the field it is really about.
 *
 * Timestamps are fixed constants, never `Date.now()`. A fixture whose value depends on when
 * the suite ran is a test that fails once a year for reasons nobody can reproduce.
 */

/** 2025-01-01T00:00:00Z. Any fixed instant; the value itself carries no meaning. */
export const FIXED_NOW = 1_735_689_600_000;

export function folder(id: string, name: string, parentId: string | null, order = 0): Folder {
  return { id, name, parentId, order };
}

export function tag(id: string, name: string, colour = 'neutral'): Tag {
  return { id, name, colour };
}

export interface RecordOverrides {
  readonly title?: string;
  readonly folderId?: string | null;
  readonly tags?: readonly string[];
  readonly favorite?: boolean;
  readonly trashedAt?: number | null;
  readonly lastUsedAt?: number | null;
  readonly useCount?: number;
}

export function record(id: string, overrides: RecordOverrides = {}): CredentialProjection {
  return {
    id,
    type: 'login',
    title: overrides.title ?? id,
    favorite: overrides.favorite ?? false,
    folderId: overrides.folderId ?? null,
    tags: overrides.tags ?? [],
    icon: { kind: 'auto' },

    username: '',
    email: '',
    urls: [],

    hasPassword: true,
    passwordLength: 16,
    hasNotes: false,
    notesLength: 0,

    securityQuestions: [],
    custom: [],
    attachments: [],

    meta: {
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      passwordUpdatedAt: FIXED_NOW,
      lastUsedAt: overrides.lastUsedAt ?? null,
      useCount: overrides.useCount ?? 0,
      expiresAt: null,
      rotationIntervalDays: null,
      createdOrigin: { action: 'create' },
    },
    historyEnabled: true,
    historyCount: 0,
    history: [],
    trashedAt: overrides.trashedAt ?? null,
  };
}

/**
 * A small healthy tree:
 *
 *   work            (w)
 *     banking       (b)
 *       personal    (bp)
 *     clients       (c)
 *   home            (h)
 */
export function healthyFolders(): readonly Folder[] {
  return [
    folder('w', 'Work', null, 0),
    folder('h', 'Home', null, 1),
    folder('b', 'Banking', 'w', 0),
    folder('c', 'Clients', 'w', 1),
    folder('bp', 'Personal', 'b', 0),
  ];
}
