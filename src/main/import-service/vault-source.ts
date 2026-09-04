// SPDX-License-Identifier: GPL-3.0-or-later
import { unlock as unlockKeys } from '../crypto/envelope.js';
import { serialiseKeyholdJson } from '../export/keyhold-json.js';
import { readContainer, readPreamble } from '../format/container.js';
import { parseVaultDocument } from '../vault/vault-service.js';
import { looksLikeKdbx, readKdbxAsImportSource } from './kdbx-source.js';
import type { PickedImportFile } from './source-store.js';

/**
 * Reading another Keyhold vault as an import source.
 *
 * ## What this does, and why it is this small
 *
 * A `.keep` **is** a Keyhold JSON document with a different envelope. So importing one is:
 * decrypt the container, re-serialise the document as Keyhold JSON, and hand it to the
 * importer as an ordinary source. The existing `keyhold-json` parser does the rest.
 *
 * That is decision D30, and the reason it is worth writing down is what it avoids. A second
 * record-mapping would drift from `keyhold-json.ts`'s, and the way it would drift is that one
 * of the two would quietly stop reporting a dropped field — which is the failure the whole
 * import pipeline is built to prevent.
 *
 * ## The passphrase does not outlive this function
 *
 * It is a parameter, used once, and never stored. The import source that comes out holds
 * plaintext exactly as a CSV source does — the same lifetime and the same risk the rest of
 * the pipeline already reasons about, rather than a new one. Nothing here writes the
 * passphrase into a descriptor, a log or an error.
 *
 * ## What is imported
 *
 * What a Keyhold JSON export carries. Record ids, created and updated dates, and history do
 * not survive, and they are **reported** rather than dropped silently — by the same code that
 * already reports them, because it is the same code. Importing a vault is a merge of
 * contents, not a restore. Restoring is copying the `.keep` file back.
 *
 * ## `.keepx` works for free, and that is not an accident
 *
 * A parcel is the same container under its own passphrase, so it decrypts through exactly
 * this path. That is the receiving end of the transfer feature: somebody sends you a
 * `.keepx`, you open it here with the passphrase they told you, and its records land in your
 * vault through the same dry run, duplicate detection and undo as any other import.
 */

/** Attachments are not carried, and the reason is stated where the user will read it. */
export const VAULT_IMPORT_DROPS_ATTACHMENTS =
  'Attachments are not imported. They live as encrypted chunks in the source vault, and the ' +
  'importer creates records rather than chunks — copy the vault file itself if you need them.';

export interface VaultSourceInput {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  /** Named for what it is. Used once, here, and never stored. */
  readonly secretPassphrase: string;
  /**
   * The unlock, injectable.
   *
   * Only so a test can hold the keys this function makes and assert they were destroyed —
   * the same reason `VaultService.unlock` takes a `DeriveKeyFn`. Without a seam there is no
   * way to observe it from outside, and "the DEK is zeroed on every path" was a claim in a
   * comment with nothing behind it. Fault injection found exactly that: removing the
   * `destroy()` failed no test at all.
   */
  readonly unlock?: typeof unlockKeys;
}

/**
 * Decrypts a Keyhold vault into the import source the rest of the pipeline expects.
 *
 * Throws the crypto layer's own `VaultError` — `WRONG_PASSWORD` for a bad passphrase,
 * `NOT_A_VAULT` for a file that is not one — because those messages are already written to
 * say what the user can do about it, and re-wrapping them here would mean a second set of
 * words for the same conditions.
 */
export async function readVaultAsImportSource(input: VaultSourceInput): Promise<PickedImportFile> {
  // A KeePass database takes the same door, and deliberately so. From the user's side both
  // are "an encrypted file I have the passphrase for", and giving them two IPC channels, two
  // dialogs and two wizard branches would be three duplicates of one act. Dispatched on the
  // file's own signature rather than on its extension, because a file somebody renamed is
  // still the file it was.
  if (looksLikeKdbx(input.bytes)) {
    return await readKdbxAsImportSource({
      fileName: input.fileName,
      bytes: input.bytes,
      secretPassphrase: input.secretPassphrase,
    });
  }

  const { header } = readPreamble(input.bytes);

  // The whole reason this function is async. Argon2 is seconds by design, and the caller is
  // an IPC handler the renderer is awaiting with a spinner.
  const unlock = input.unlock ?? unlockKeys;
  const keys = await unlock(input.secretPassphrase, header.kdf, header.wrappedDek);

  try {
    const contents = readContainer(input.bytes, keys.dek);
    const document = parseVaultDocument(contents.body);

    // `pretty: false`. This string is a plaintext credential dump held for the length of the
    // wizard; there is no reader, and the indentation would be a third of its size again.
    const json = serialiseKeyholdJson(document, { now: Date.now(), pretty: false });

    return {
      // The vault's own name, so the wizard's first screen says the file the user picked
      // rather than something this function invented.
      fileName: input.fileName,
      bytes: new TextEncoder().encode(json),
    };
  } finally {
    // On every path including the failing ones. The DEK is live key material and the reason
    // to destroy it here rather than at the end of the happy path is that a malformed body
    // is exactly when it would otherwise be forgotten.
    keys.dek.destroy();
  }
}
