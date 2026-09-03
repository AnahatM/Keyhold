// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Types and constants for the KEEP container format.
 *
 * This file lives in `@shared` and therefore must compile in BOTH the Node and the
 * browser environments: it contains types, sizes and identifiers only, never an
 * implementation. Every function that touches key material or the filesystem lives in
 * `src/main` where the renderer cannot reach it (decision D22).
 *
 * The format is documented for third parties in `docs/04-Vault-Format/`. Anything here
 * that changes is a format change and needs a version bump plus a migration.
 */

/** ASCII "KEYHOLD\0". The first eight bytes of every `.keep` file. */
export const MAGIC = Uint8Array.from([0x4b, 0x45, 0x59, 0x48, 0x4f, 0x4c, 0x44, 0x00]);

export const MAGIC_LENGTH = 8;

/**
 * Current container version.
 *
 * A file declaring a HIGHER version than this is refused outright rather than parsed
 * optimistically — reading a future format with today's rules is how a vault gets
 * silently truncated on the next save.
 */
export const FORMAT_VERSION = 1;

// ── Field widths, in bytes ────────────────────────────────────────────────────
export const VERSION_FIELD_BYTES = 2;
export const LENGTH_FIELD_BYTES = 4;
export const CHUNK_ID_BYTES = 16;

// ── Cryptographic sizes ───────────────────────────────────────────────────────
/** AES-256. */
export const KEY_BYTES = 32;
/** GCM's recommended nonce length. Longer nonces are re-hashed and gain nothing. */
export const NONCE_BYTES = 12;
/** Full-length GCM authentication tag. Never truncate it. */
export const TAG_BYTES = 16;
/** Argon2id salt. 16 bytes is the RFC 9106 recommendation. */
export const SALT_BYTES = 16;

export const CIPHER_ID = 'AES-256-GCM' as const;
export const KDF_ID = 'argon2id' as const;

/**
 * Argon2id parameters, stored in the header so a vault carries its own settings.
 *
 * This is what makes it safe to raise the defaults over time: an old vault keeps
 * opening with the parameters it was created with, and is upgraded only when the user
 * explicitly re-keys.
 */
export interface KdfParams {
  readonly alg: typeof KDF_ID;
  /** Memory cost in kibibytes. */
  readonly memoryKib: number;
  /** Time cost — passes over memory. */
  readonly iterations: number;
  /** Degree of parallelism (lanes). */
  readonly parallelism: number;
  /** Base64 salt. */
  readonly salt: string;
}

/**
 * OWASP's minimum recommendation is m=19 MiB, t=2, p=1. Keyhold's floor is well above
 * that because this is a desktop app unlocked a handful of times a day, not a server
 * authenticating thousands of requests a second — spending ~half a second is free here
 * and expensive for an attacker.
 */
export const DEFAULT_KDF_PARAMS = {
  alg: KDF_ID,
  memoryKib: 65_536, // 64 MiB
  iterations: 3,
  parallelism: 4,
} as const;

/** Refuse anything weaker than this, even if a file asks for it. */
export const MIN_KDF_PARAMS = {
  memoryKib: 19_456, // 19 MiB — the OWASP floor
  iterations: 2,
  parallelism: 1,
} as const;

/**
 * Refuse anything so large it would hang or OOM the app. A hostile `.keep` could
 * otherwise declare 64 GiB of memory cost and turn opening a file into a denial of
 * service.
 */
export const MAX_KDF_PARAMS = {
  memoryKib: 2_097_152, // 2 GiB
  iterations: 32,
  parallelism: 16,
} as const;

/** An AES-256-GCM ciphertext with its nonce, all base64. */
export interface SealedBox {
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

/**
 * The plaintext header.
 *
 * Readable without the password — it must be, since it says how to derive the key — but
 * passed as AAD to the body's AEAD, so altering any of it breaks authentication. That is
 * exactly what AAD is for.
 */
export interface KeepHeader {
  readonly formatVersion: number;
  /** Stable identity of this vault across copies and devices. UUID. */
  readonly vaultId: string;
  /** Which device last wrote the file. Used by sync to detect its own writes. */
  readonly deviceId: string;
  readonly kdf: KdfParams;
  readonly cipher: typeof CIPHER_ID;
  /** The DEK, encrypted under the KEK. */
  readonly wrappedDek: SealedBox;
  readonly createdAt: number;
  readonly modifiedAt: number;
  /** Monotonic, incremented on every save. Cheap external-change detection. */
  readonly generation: number;
  /**
   * SHA-256 of the plaintext body, as 64 lowercase hex characters — or absent.
   *
   * **Optional, and it has to stay optional.** Every vault written before this field existed
   * has none, and the reader keeps the file's own header bytes as the AAD rather than
   * re-serialising, so an older file's tag still verifies against exactly the bytes it was
   * sealed with. Adding a *required* field would have broken every existing vault, silently,
   * at the point of opening it.
   *
   * ## What it is for, and what it is not
   *
   * `generation` already answers "has this file been written since I last read it" — it is a
   * counter and it is cheap. It cannot answer "is this file's content different from mine",
   * which is a different question and the one sync actually has. Two devices editing from
   * the same ancestor reach generation 8 independently and disagree completely; a device
   * that copies a vault and copies it back has a higher generation and identical content.
   * A merge in the first case is necessary and in the second is pure cost — a mandatory
   * backup, a full three-way pass, and a resolver prompt for a file nobody changed.
   *
   * Of the **plaintext** body, deliberately. The ciphertext differs on every save whatever
   * the content — a fresh nonce is drawn each time, which is the one thing that must never
   * be reused — so hashing the sealed bytes would answer "was this saved again", which is
   * what `generation` already says, less usefully.
   *
   * It is not a integrity check. The GCM tag is, over both the body and this header, and it
   * is checked on every open. This is for deciding whether two files need reconciling.
   */
  readonly contentHash?: string;
  readonly recordCount: number;
  readonly attachmentCount: number;
}

/** One encrypted attachment, stored as its own chunk after the body. */
export interface AttachmentChunk {
  /** 32 lowercase hex characters (16 bytes). */
  readonly id: string;
  readonly data: Uint8Array;
}

/** What a caller hands the writer, and gets back from the reader. */
export interface VaultContents {
  /** The records payload. Opaque to the container — it is JSON today, by convention. */
  readonly body: Uint8Array;
  readonly attachments: readonly AttachmentChunk[];
}

/**
 * Hard ceiling on a single decompressed body, to bound a decompression bomb.
 * A 256 MiB vault of text records is already absurd; a `.keep` claiming more is hostile.
 */
export const MAX_BODY_BYTES = 268_435_456; // 256 MiB

/** Hard ceiling on one attachment chunk. The UI enforces a much lower default. */
export const MAX_CHUNK_BYTES = 268_435_456; // 256 MiB
