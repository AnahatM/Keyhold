// SPDX-License-Identifier: GPL-3.0-or-later
import { KEY_BYTES, type KdfParams, type SealedBox } from '@shared/format/types.js';
import { decrypt, encrypt, fromSealedBox, toSealedBox } from './aead.js';
import { wrongPassword } from './errors.js';
import { deriveKey } from './kdf.js';
import { randomSecret } from './random.js';
import { SecretBytes } from './secret.js';

/**
 * Envelope encryption — the reason changing your master password is instant.
 *
 *     master password ──Argon2id──► KEK ──unwraps──► DEK ──encrypts──► the vault
 *
 * The vault body is encrypted with a random **data key** (DEK). The password only ever
 * derives a **key-encryption key** (KEK), which encrypts that DEK. Three consequences,
 * all of which are why this indirection is worth the extra concept:
 *
 *  1. **Changing the master password rewraps 32 bytes**, instead of decrypting and
 *     re-encrypting an entire vault. On a large vault that is the difference between
 *     instant and a progress bar — and, more importantly, between an atomic operation
 *     and one that can fail halfway through and lose data.
 *
 *  2. **Extra unlock methods are additive.** Biometric quick-unlock stores its own
 *     independently wrapped copy of the same DEK in the OS keychain. Revoking it deletes
 *     that copy and touches nothing else. The same shape covers the key-file and
 *     hardware-key factors in the backlog (A3, D1) with no format change.
 *
 *  3. **The DEK can be rotated** without the user changing anything they have to
 *     remember.
 */

export interface UnlockedVaultKeys {
  /** Encrypts and decrypts the vault body and every attachment chunk. */
  readonly dek: SecretBytes;
}

/** A brand-new random data key, for a new vault or a rotation. */
export function generateDek(): SecretBytes {
  return randomSecret(KEY_BYTES);
}

/** Encrypts the DEK under the KEK, in the base64 form the header stores. */
export function wrapDek(kek: SecretBytes, dek: SecretBytes): SealedBox {
  return dek.use((dekBytes) => toSealedBox(encrypt(kek, dekBytes)));
}

/**
 * Recovers the DEK from its wrapped form.
 *
 * A failure here is overwhelmingly "wrong password", and is reported as such — but note
 * that the check is the AEAD tag on the wrapped key, not a comparison against a stored
 * verifier. There is deliberately no way to test a password without attempting real
 * decryption; a separate verifier would be an oracle, and would also be one more thing
 * that could disagree with the actual key.
 */
export function unwrapDek(kek: SecretBytes, wrapped: SealedBox): SecretBytes {
  try {
    const dekBytes = decrypt(kek, fromSealedBox(wrapped));
    if (dekBytes.length !== KEY_BYTES) {
      // Right password, wrong-sized key: the header is internally inconsistent.
      throw new Error(`Unwrapped data key is ${dekBytes.length} bytes, expected ${KEY_BYTES}.`);
    }
    return SecretBytes.adopt(dekBytes);
  } catch {
    // Deliberately swallows the underlying cause: the distinction between "tag mismatch"
    // and "wrong key length" is not useful to the user and the message must not hint at
    // how close a guess was.
    throw wrongPassword();
  }
}

/**
 * Full unlock: password → KEK → DEK.
 *
 * The KEK is destroyed before returning. It has done its one job, and keeping a
 * password-derived key alive for the whole session buys nothing while widening the
 * window in which it can be read out of memory.
 */
export async function unlock(
  password: string,
  params: KdfParams,
  wrappedDek: SealedBox
): Promise<UnlockedVaultKeys> {
  const kek = await deriveKey({ password, params });
  try {
    return { dek: unwrapDek(kek, wrappedDek) };
  } finally {
    kek.destroy();
  }
}

/**
 * Creates the key material for a new vault, and returns the wrapped DEK to store.
 *
 * The DEK is returned live so the caller can immediately encrypt the first body; the KEK
 * is destroyed here for the same reason as in `unlock`.
 */
export async function createVaultKeys(
  password: string,
  params: KdfParams
): Promise<{ keys: UnlockedVaultKeys; wrappedDek: SealedBox }> {
  const kek = await deriveKey({ password, params });
  try {
    const dek = generateDek();
    return { keys: { dek }, wrappedDek: wrapDek(kek, dek) };
  } finally {
    kek.destroy();
  }
}

/**
 * Re-wraps the existing DEK under a new password.
 *
 * This is the whole password-change operation: the vault body is not touched, so there
 * is nothing to half-write and nothing to lose.
 */
export async function rewrapForNewPassword(
  dek: SecretBytes,
  newPassword: string,
  newParams: KdfParams
): Promise<SealedBox> {
  const kek = await deriveKey({ password: newPassword, params: newParams });
  try {
    return wrapDek(kek, dek);
  } finally {
    kek.destroy();
  }
}
