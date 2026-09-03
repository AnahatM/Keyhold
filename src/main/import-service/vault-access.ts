// SPDX-License-Identifier: GPL-3.0-or-later
import type { ChangeOrigin, HistoryAction } from '@shared/model/credential.js';
import type { VaultDocument } from '@shared/model/vault-document.js';
import { uuid } from '../crypto/random.js';
import type { OpsContext } from '../vault/credential-ops.js';
import type { VaultService } from '../vault/vault-service.js';

/**
 * The vault, as the import service is allowed to see it.
 *
 * **Six functions, and not a `VaultService`.** That is the whole point of this file. An
 * import is the most consequential write in the app — it can add three thousand records and
 * a folder tree in one go — so its rules are exactly the ones that have to be tested
 * exhaustively. Depending on `VaultService` directly would mean every one of those tests
 * needed a real file, a real master password and a real Argon2 derivation: seconds per case,
 * on a class whose own tests already cover unlocking. Behind this interface the same tests
 * run against a plain object holding a document, in microseconds, with no key in sight.
 *
 * It is narrow for a second reason. Nothing here can read a secret *out* of the vault except
 * through the document, and nothing here can write one anywhere except back into it — so a
 * reviewer can see the entire blast radius of the import service by reading six lines.
 */
export interface ImportVaultAccess {
  /**
   * The decrypted document.
   *
   * Main-process only, and read for two things: the existing records the match rule needs,
   * and the folder tree the `import-folder:` placeholders resolve against. It is never
   * projected wholesale to anyone.
   */
  readonly document: () => VaultDocument;

  /** Installs the document the commit built. Marks the vault dirty; does not write it. */
  readonly replaceDocument: (document: VaultDocument) => void;

  /**
   * The context `buildCredential` needs: ids, a clock, the vault's settings, and the
   * provenance capture.
   *
   * Supplied by the vault rather than assembled here so an imported record's history
   * settings and `createdOrigin` are decided by exactly the same code that decides them for
   * a record the user typed. An import that quietly opted its records out of history would
   * be a second definition of what a new record is.
   */
  readonly opsContext: () => OpsContext;

  /** The save generation now. Moves only when the vault is actually written. */
  readonly generation: () => number;

  /** True when the in-memory document differs from the file. Half of the undo guard. */
  readonly hasUnsavedChanges: () => boolean;

  /** Writes the vault, and returns the generation the write produced. */
  readonly save: () => Promise<number>;
}

/**
 * Adapts the real `VaultService`.
 *
 * `captureOrigin` is a parameter rather than something read off the service because
 * `VaultService` keeps its provenance source private, and because the honest default when
 * nobody wires one is to record *less* than the machine could tell us — the verb, and
 * nothing about the device. That default matches `NO_ORIGIN` in `vault-service.ts`
 * deliberately: a wiring that forgets this argument under-records, never over-records.
 *
 * The settings are read per call, not captured once, because the user can change history
 * retention in another window mid-import and the records written after that change should
 * honour it.
 */
export function createVaultImportAccess(
  vault: VaultService,
  captureOrigin?: (action: HistoryAction) => ChangeOrigin
): ImportVaultAccess {
  return {
    document: () => vault.documentUnsafe(),
    replaceDocument: (document) => {
      vault.replaceDocument(document);
    },
    opsContext: () => ({
      newId: uuid,
      now: Date.now,
      settings: vault.documentUnsafe().settings,
      ...(captureOrigin === undefined ? {} : { captureOrigin }),
    }),
    generation: () => vault.summary().generation,
    hasUnsavedChanges: () => vault.hasUnsavedChanges,
    save: async () => (await vault.save()).generation,
  };
}
