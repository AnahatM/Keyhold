// SPDX-License-Identifier: GPL-3.0-or-later
import type { AttachmentChunk, KdfParams } from '@shared/format/types.js';
import type { ExportFormatId } from '@shared/model/export.js';
import type { VaultDocument } from '@shared/model/vault-document.js';
import { createVaultKeys, type DeriveKeyFn } from '../crypto/envelope.js';
import { newKdfParams } from '../crypto/kdf.js';
import { uuid } from '../crypto/random.js';
import { writeContainer } from '../format/container.js';
import { newHeader } from '../format/header.js';
import { serialiseKeyholdJson } from './keyhold-json.js';
import { reportSelectionLosses, selectRecords, type ExportSelection } from './select.js';
import { encryptedExport, LossLog, type EncryptedExport } from './types.js';

/**
 * The encrypted export: the Keyhold JSON, sealed in a KEEP container under its own
 * passphrase.
 *
 * ## Nothing here is new cryptography, and that is the point
 *
 * The whole of this file is composition. `createVaultKeys` derives a KEK with Argon2id and
 * wraps a fresh random DEK; `newHeader` builds the plaintext header that becomes the AAD;
 * `writeContainer` compresses, encrypts with AES-256-GCM and frames the result. There is no
 * second AEAD path, no hand-rolled key derivation, and no place where a nonce is chosen. If
 * this file has a bug it is a composition bug, not a cryptographic one — which is the only
 * kind of crypto bug worth being able to have.
 *
 * ## Why the output is a `.keepx` and not a `.keep`
 *
 * A `.keep` is *the vault*, opened with the master password. A `.keepx` is *a parcel*: a
 * chosen subset, under a passphrase of its own, so handing one over never means handing over
 * the master password. This function takes an explicit passphrase and an optional set of
 * record ids — it is a parcel by construction, and calling its output a `.keep` would blur
 * exactly the distinction the glossary asks to be kept sharp. Saving the vault itself
 * elsewhere is `VaultService.save()` to another path, not an export.
 *
 * ## Why the bytes are deliberately not deterministic
 *
 * Every other exporter here is byte-deterministic and tested for it. This one is not, and
 * must not be: each call draws a fresh salt, a fresh data key and a fresh nonce for every
 * region it encrypts. A deterministic encrypted export would mean reusing a nonce under a
 * reused key, which in GCM leaks the XOR of the two plaintexts and makes forgery possible.
 * The determinism that matters here is the *payload's* — the plaintext under the seal is the
 * same bytes every time, which the round-trip test checks after decrypting.
 *
 * ## What comes back out
 *
 * The sealed payload is the Keyhold JSON envelope, whose top level is a superset of a vault
 * body. So a parcel opens two ways: through `parseKeyholdJson` for a full-fidelity read, and
 * through the ordinary unlock path, because `parseVaultDocument` finds everything it needs at
 * the top level. Both are asserted in `encrypted.test.ts`.
 */

const FORMAT: ExportFormatId = 'keyhold-parcel';
const EXTENSION = '.keepx';

export interface EncryptedExportOptions extends ExportSelection {
  /** The parcel's own passphrase. Never the master password — the caller must not pass it. */
  readonly password: string;
  /** Stamped into the header. A parameter, so this function has no clock of its own. */
  readonly now: number;
  /**
   * The attachment chunks the vault holds.
   *
   * Passed in because a `VaultDocument` carries attachment *metadata* while the bytes live in
   * the open container. Only the chunks belonging to selected records are written: a parcel
   * of three records must not carry the 20 MB PDF attached to a fourth, which would be a
   * disclosure the sender never agreed to and could not see.
   */
  readonly attachments?: readonly AttachmentChunk[] | undefined;
  /** Argon2 cost. Defaults to the shipped parameters; the floor still applies. */
  readonly kdf?: Partial<Pick<KdfParams, 'memoryKib' | 'iterations' | 'parallelism'>> | undefined;
  readonly vaultId?: string | undefined;
  readonly deviceId?: string | undefined;
  /** Where Argon2 runs. Injected so the caller keeps it off the UI thread. */
  readonly derive?: DeriveKeyFn | undefined;
}

export async function exportEncrypted(
  document: VaultDocument,
  options: EncryptedExportOptions
): Promise<EncryptedExport> {
  const selected = selectRecords(document, options);
  const losses = new LossLog();
  reportSelectionLosses(selected, losses);

  const wanted = new Set<string>();
  for (const record of selected.records) {
    for (const attachment of record.attachments) wanted.add(attachment.id);
  }

  const supplied = options.attachments ?? [];
  const chunks = supplied.filter((chunk) => wanted.has(chunk.id));
  const missing = wanted.size - chunks.length;
  if (missing > 0) {
    losses.add(
      'dropped',
      'attachment contents',
      `${missing} attached file(s) were not available to the export and are missing from the parcel. Their names and sizes are still on the records.`,
      missing
    );
  }

  // Named field by field rather than spread from `options`, so the passphrase and the
  // attachment chunks cannot drift into the payload serialiser on some future refactor.
  const payload = serialiseKeyholdJson(document, {
    now: options.now,
    includeTrashed: options.includeTrashed,
    recordIds: options.recordIds,
  });
  const body = new Uint8Array(Buffer.from(payload, 'utf8'));

  const kdf = newKdfParams(options.kdf);
  const { keys, wrappedDek } = await createVaultKeys(options.password, kdf, options.derive);
  try {
    const header = newHeader({
      vaultId: options.vaultId ?? uuid(),
      deviceId: options.deviceId ?? uuid(),
      kdf,
      wrappedDek,
      now: options.now,
    });

    const bytes = writeContainer(
      {
        ...header,
        recordCount: selected.records.length,
        attachmentCount: chunks.length,
      },
      { body, attachments: chunks },
      keys.dek
    );

    return encryptedExport({
      format: FORMAT,
      extension: EXTENSION,
      bytes,
      recordCount: selected.records.length,
      losses: losses.all,
    });
  } finally {
    // The key has done its one job. Holding it past the write buys nothing and widens the
    // window in which it can be read out of a swapped page or a core dump.
    keys.dek.destroy();
  }
}
