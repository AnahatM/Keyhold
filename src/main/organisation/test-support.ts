// SPDX-License-Identifier: GPL-3.0-or-later
import type { Credential } from '@shared/model/credential.js';
import { DEFAULT_VAULT_SETTINGS, type VaultDocument } from '@shared/model/vault-document.js';
import {
  addCredential,
  buildCredential,
  type NewCredentialInput,
  type OpsContext,
} from '../vault/credential-ops.js';

/**
 * Fixture builders shared by this module's tests.
 *
 * Test-only, and imported by nothing that ships — it lives here rather than under a
 * `fixtures/` directory so it is type-checked by the same project as the code it builds
 * fixtures for, which is what makes a change to `Credential` a compile error here rather
 * than a runtime surprise in a test.
 *
 * Records are built through the real `buildCredential` rather than assembled by hand, so a
 * folder or tag test is always operating on the exact shape the vault stores. A hand-rolled
 * literal would keep compiling after a model change that these operations would not survive.
 */

let nextRecordId = 0;

/** Makes ids predictable when a test compares two independently built documents. */
export function resetIds(): void {
  nextRecordId = 0;
}

const recordContext = (): OpsContext => ({
  newId: () => `rec-${++nextRecordId}`,
  now: () => 1_700_000_000_000,
  settings: DEFAULT_VAULT_SETTINGS,
});

export function credential(
  title: string,
  extra: Omit<NewCredentialInput, 'title'> = {}
): Credential {
  return buildCredential({ title, ...extra }, recordContext());
}

export function addRecord(document: VaultDocument, record: Credential): VaultDocument {
  return addCredential(document, record);
}

/** A record already in the trash, for the checks that must reach past the default filter. */
export function trashedCredential(
  title: string,
  extra: Omit<NewCredentialInput, 'title'> = {}
): Credential {
  return { ...credential(title, extra), trashedAt: 1_700_000_000_000 };
}
