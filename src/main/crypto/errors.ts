// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Structured errors for the crypto and container layers.
 *
 * Two rules govern everything here:
 *
 *  1. **An error message never contains secret material** — no key, no password, no
 *     plaintext, no full filesystem path. Errors get logged, screenshotted, and pasted
 *     into bug reports; anything in one is effectively public.
 *
 *  2. **"Wrong password" and "corrupt file" are reported as distinct codes, but both are
 *     produced only after the same authenticated decryption fails.** We never *test* the
 *     password separately from decrypting, because a separate check is a verification
 *     oracle. The distinction is inferred from where in the sequence the failure
 *     happened, and is a UX affordance rather than a cryptographic statement.
 */

export type VaultErrorCode =
  /** Not a Keyhold file at all — the magic bytes are wrong. */
  | 'NOT_A_VAULT'
  /** Written by a newer Keyhold. Refused rather than guessed at. */
  | 'UNSUPPORTED_VERSION'
  /** Structurally broken: truncated, bad lengths, unparseable header. */
  | 'MALFORMED'
  /** The DEK would not unwrap. Almost always the wrong password. */
  | 'WRONG_PASSWORD'
  /** Authentication failed on data that is not the wrapped key: tampering or corruption. */
  | 'TAMPERED'
  /** Header declares KDF parameters outside the accepted range. */
  | 'BAD_KDF_PARAMS'
  /** A declared size exceeds the safety ceiling — a decompression or allocation bomb. */
  | 'TOO_LARGE'
  /** Attachment bytes did not match their recorded hash. */
  | 'CHUNK_INTEGRITY'
  /** A reload would have thrown away edits that are only in memory. */
  | 'UNSAVED_CHANGES'
  /** A different vault is at the path this one was opened from. */
  | 'DIFFERENT_VAULT';

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VaultError';
    this.code = code;
  }

  /** True when the user can plausibly fix this by typing a different password. */
  get isRecoverable(): boolean {
    return this.code === 'WRONG_PASSWORD';
  }
}

export function notAVault(): VaultError {
  return new VaultError(
    'NOT_A_VAULT',
    'This file is not a Keyhold vault — it does not start with the KEEP signature.'
  );
}

export function unsupportedVersion(found: number, supported: number): VaultError {
  return new VaultError(
    'UNSUPPORTED_VERSION',
    `This vault uses KEEP format version ${found}, but this build understands up to ${supported}. Update Keyhold to open it. It has not been modified.`
  );
}

export function malformed(detail: string): VaultError {
  return new VaultError('MALFORMED', `This vault file is damaged: ${detail}`);
}

export function wrongPassword(): VaultError {
  return new VaultError(
    'WRONG_PASSWORD',
    'Could not unlock the vault. The master password is incorrect, or the file has been altered.'
  );
}

export function tampered(what: string): VaultError {
  return new VaultError(
    'TAMPERED',
    `Authentication failed while reading ${what}. The file has been modified or corrupted since it was written.`
  );
}

export function badKdfParams(detail: string): VaultError {
  return new VaultError(
    'BAD_KDF_PARAMS',
    `Unsafe key-derivation settings in this vault: ${detail}`
  );
}

export function tooLarge(what: string, size: number, limit: number): VaultError {
  return new VaultError(
    'TOO_LARGE',
    `Refusing to read ${what}: it declares ${size} bytes, above the ${limit}-byte safety limit.`
  );
}

/**
 * Refuses to re-read a file over edits that exist only in memory.
 *
 * The caller is expected to have checked already — the reload prompt only offers the button
 * when there is nothing to lose. This is the layer that makes "never lose data" true rather
 * than intended: a caller that forgets, or a race in which an edit lands between the check
 * and the call, gets an error instead of a silent deletion.
 */
export function unsavedChanges(): VaultError {
  return new VaultError(
    'UNSAVED_CHANGES',
    'This vault has changes that have not been saved yet, so it cannot be reloaded from disk.'
  );
}

/**
 * A different vault at the same path.
 *
 * Not "the file changed" — a different `vaultId` means the file was replaced by somebody
 * else's vault, or restored from an unrelated backup. Reading it into this session would put
 * two people's credentials behind one master password.
 */
export function differentVault(): VaultError {
  return new VaultError(
    'DIFFERENT_VAULT',
    'The file at this path is a different vault from the one that is open.'
  );
}

export function chunkIntegrity(chunkId: string): VaultError {
  // The chunk id is a random identifier, not user content — safe to include, and it is
  // the only way to say which attachment failed.
  return new VaultError(
    'CHUNK_INTEGRITY',
    `Attachment ${chunkId} failed its integrity check and was not returned.`
  );
}
