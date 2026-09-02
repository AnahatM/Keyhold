// SPDX-License-Identifier: GPL-3.0-or-later
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { KEY_BYTES, NONCE_BYTES, TAG_BYTES, type SealedBox } from '@shared/format/types.js';
import { randomBytes } from './random.js';
import type { SecretBytes } from './secret.js';

/**
 * AES-256-GCM, the only symmetric cipher Keyhold uses.
 *
 * GCM is an AEAD: it encrypts and authenticates in one pass, so a modified ciphertext
 * fails loudly instead of decrypting to plausible garbage. That property is what lets
 * the vault say "this file has been tampered with" rather than silently loading
 * corrupted records.
 *
 * Two invariants this module exists to enforce:
 *
 *  - **A nonce is generated fresh for every encryption, from the CSPRNG, and is never
 *    reused under the same key.** Nonce reuse in GCM is catastrophic — it leaks the XOR
 *    of two plaintexts and, worse, allows forgery of further messages. There is
 *    deliberately no API here that accepts a caller-supplied nonce for encryption.
 *  - **The tag is never truncated.** A shortened tag makes forgery cheaper for no real
 *    saving.
 */

const ALGORITHM = 'aes-256-gcm';

export interface EncryptedBytes {
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
}

function assertKeyLength(key: SecretBytes): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`AES-256-GCM requires a ${KEY_BYTES}-byte key, got ${key.length}.`);
  }
}

/**
 * Encrypts `plaintext`, optionally binding it to `aad`.
 *
 * `aad` is authenticated but not encrypted. The container passes the plaintext header
 * here, so that editing the header — the KDF parameters, the generation counter, the
 * wrapped key — breaks the body's tag. That is the whole reason the header can safely
 * be readable without the password.
 */
export function encrypt(key: SecretBytes, plaintext: Uint8Array, aad?: Uint8Array): EncryptedBytes {
  assertKeyLength(key);

  const nonce = randomBytes(NONCE_BYTES);

  return key.use((keyBytes) => {
    const cipher = createCipheriv(ALGORITHM, keyBytes, nonce, { authTagLength: TAG_BYTES });
    if (aad !== undefined) cipher.setAAD(aad);

    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      nonce,
      ciphertext: new Uint8Array(ciphertext),
      tag: new Uint8Array(cipher.getAuthTag()),
    };
  });
}

/**
 * Decrypts and verifies.
 *
 * Throws if the tag does not match — which happens for a wrong key, a modified
 * ciphertext, a modified nonce, or modified AAD. The caller decides how to describe
 * that; see `errors.ts` on why "wrong password" and "tampered" are the same event
 * reported differently.
 */
export function decrypt(key: SecretBytes, box: EncryptedBytes, aad?: Uint8Array): Uint8Array {
  assertKeyLength(key);

  if (box.nonce.length !== NONCE_BYTES) {
    throw new Error(`Expected a ${NONCE_BYTES}-byte nonce, got ${box.nonce.length}.`);
  }
  if (box.tag.length !== TAG_BYTES) {
    throw new Error(`Expected a ${TAG_BYTES}-byte authentication tag, got ${box.tag.length}.`);
  }

  return key.use((keyBytes) => {
    const decipher = createDecipheriv(ALGORITHM, keyBytes, box.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(box.tag);
    if (aad !== undefined) decipher.setAAD(aad);

    // `final()` is what verifies the tag. Never skip it, and never use output produced
    // by `update()` before it has returned.
    return new Uint8Array(Buffer.concat([decipher.update(box.ciphertext), decipher.final()]));
  });
}

// ── Base64 form, for the JSON header ─────────────────────────────────────────

export function toSealedBox(encrypted: EncryptedBytes): SealedBox {
  return {
    nonce: Buffer.from(encrypted.nonce).toString('base64'),
    ciphertext: Buffer.from(encrypted.ciphertext).toString('base64'),
    tag: Buffer.from(encrypted.tag).toString('base64'),
  };
}

export function fromSealedBox(box: SealedBox): EncryptedBytes {
  return {
    nonce: new Uint8Array(Buffer.from(box.nonce, 'base64')),
    ciphertext: new Uint8Array(Buffer.from(box.ciphertext, 'base64')),
    tag: new Uint8Array(Buffer.from(box.tag, 'base64')),
  };
}
