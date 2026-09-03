// SPDX-License-Identifier: GPL-3.0-or-later
import type { Credential } from '@shared/model/credential.js';
import {
  DEFAULT_VAULT_SETTINGS,
  emptyVaultDocument,
  type VaultDocument,
} from '@shared/model/vault-document.js';
import { findOrCreateFolderPath } from '../organisation/folder-ops.js';
import {
  addCredential,
  buildCredential,
  type NewCredentialInput,
  type OpsContext,
} from '../vault/credential-ops.js';
import type { ImportFilePicker } from './file-picker.js';
import type { PickedImportFile } from './source-store.js';
import type { ImportVaultAccess } from './vault-access.js';

/**
 * Fixtures for this module's tests.
 *
 * Test-only, and imported by nothing that ships — it lives here rather than under a
 * `fixtures/` directory so it is type-checked by the same project as the code it builds
 * fixtures for, which is what makes a change to `Credential` a compile error here rather
 * than a runtime surprise in a test. The same reasoning as
 * `src/main/organisation/test-support.ts`, and the same shape.
 *
 * {@link FakeVault} is the reason the import service takes its vault as an interface. Every
 * behavioural test in this folder runs against this object: no file, no master password, no
 * Argon2 derivation, and a `generation` a test can move by hand to assert what the undo
 * guard does when it moves.
 */

export class FakeVault {
  document: VaultDocument;
  /** Bumped by `save()`, exactly as a real vault's header generation is. */
  generation = 1;
  dirty = false;
  saveCount = 0;
  #ids = 0;

  constructor(document: VaultDocument = emptyVaultDocument()) {
    this.document = document;
  }

  /** Predictable ids, so a test can name the record it expects an undo to have removed. */
  newId = (): string => `id-${(this.#ids += 1)}`;

  now = (): number => 1_700_000_000_000;

  opsContext = (): OpsContext => ({
    newId: this.newId,
    now: this.now,
    settings: this.document.settings,
  });

  /** Adds a record as though the user had created it. Returns the record, for its id. */
  seed(input: NewCredentialInput): Credential {
    const credential = buildCredential(input, this.opsContext());
    this.document = addCredential(this.document, credential);
    return credential;
  }

  /** Adds a folder tree as though the user had built it. Returns the deepest folder's id. */
  seedFolder(path: string): string {
    const result = findOrCreateFolderPath(this.document, path, this.opsContext());
    this.document = result.document;
    return result.folder?.id ?? '';
  }

  get access(): ImportVaultAccess {
    return {
      document: () => this.document,
      replaceDocument: (document) => {
        this.document = document;
        this.dirty = true;
      },
      opsContext: this.opsContext,
      generation: () => this.generation,
      hasUnsavedChanges: () => this.dirty,
      save: () => {
        this.saveCount += 1;
        this.generation += 1;
        this.dirty = false;
        return Promise.resolve(this.generation);
      },
    };
  }
}

export function emptyDocument(): VaultDocument {
  return emptyVaultDocument(DEFAULT_VAULT_SETTINGS);
}

/** Fresh bytes every call: `holdSource` takes ownership and zeroes them on discard. */
export function textFile(fileName: string, text: string): PickedImportFile {
  return { fileName, bytes: new Uint8Array(Buffer.from(text, 'utf8')) };
}

/**
 * A picker that hands over the same file each time, rebuilt on every call.
 *
 * Rebuilt because `discard` zeroes the bytes it was given, and a test that chooses the same
 * file twice must get a live copy the second time rather than a buffer of zeroes.
 */
export function fakePicker(build: () => PickedImportFile | null): ImportFilePicker {
  return { pick: () => Promise.resolve(build()) };
}

// ── A Bitwarden CSV, built row by row ────────────────────────────────────────

export const BITWARDEN_HEADER =
  'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp';

export interface BitwardenRow {
  readonly folder?: string;
  readonly name: string;
  readonly notes?: string;
  readonly fields?: string;
  readonly uri?: string;
  readonly username?: string;
  readonly password?: string;
}

/**
 * A real Bitwarden CSV, so the tests drive the real parser.
 *
 * Not a hand-built `ImportResult`: the point of a test in this folder is that the preview
 * the user approves and the records the commit writes come out of the same parse, and a
 * fixture that skipped the parse would be asserting that about code it had replaced.
 */
export function bitwardenCsv(rows: readonly BitwardenRow[]): string {
  const cell = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  const lines = rows.map((row) =>
    [
      row.folder ?? '',
      '',
      'login',
      row.name,
      row.notes ?? '',
      row.fields ?? '',
      '',
      row.uri ?? '',
      row.username ?? '',
      row.password ?? '',
      '',
    ]
      .map(cell)
      .join(',')
  );
  return [BITWARDEN_HEADER, ...lines].join('\n');
}
