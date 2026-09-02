// SPDX-License-Identifier: GPL-3.0-or-later

import type { CredentialProjection } from '@shared/model/credential.js';
import type { CommandDefinition, ResolvedCommand } from './command-registry.js';

/**
 * Fixtures shared by the tests in this folder.
 *
 * A file rather than a copy in each test, for the usual reason: five slightly different
 * hand-built projections drift, and a test that passes because its fixture is subtly wrong
 * proves nothing. This one mirrors the factory in `@shared/search/filter.test.ts`.
 *
 * Not a `.test.ts` file, so vitest does not try to run it as a suite.
 */

const NOW = 1_700_000_000_000;

export function projection(overrides: Partial<CredentialProjection> = {}): CredentialProjection {
  return {
    id: 'c1',
    type: 'login',
    title: 'Untitled',
    favorite: false,
    folderId: null,
    tags: [],
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
      createdAt: NOW,
      updatedAt: NOW,
      passwordUpdatedAt: NOW,
      lastUsedAt: null,
      useCount: 0,
      expiresAt: null,
      rotationIntervalDays: null,
      createdOrigin: { action: 'create' },
    },
    historyEnabled: true,
    historyCount: 0,
    history: [],
    trashedAt: null,
    ...overrides,
  };
}

/** A resolved command whose handler records that it ran. */
export function command(
  overrides: Partial<CommandDefinition> = {},
  run: () => void = () => undefined
): ResolvedCommand {
  return {
    definition: {
      id: 'vault.lock',
      title: 'Lock the vault',
      section: 'Vault',
      keywords: [],
      requiresSelection: false,
      destructive: false,
      ...overrides,
    },
    run,
  };
}
