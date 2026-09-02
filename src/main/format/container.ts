// SPDX-License-Identifier: GPL-3.0-or-later
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  CHUNK_ID_BYTES,
  FORMAT_VERSION,
  LENGTH_FIELD_BYTES,
  MAGIC,
  MAGIC_LENGTH,
  MAX_BODY_BYTES,
  MAX_CHUNK_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
  VERSION_FIELD_BYTES,
  type AttachmentChunk,
  type KeepHeader,
  type VaultContents,
} from '@shared/format/types.js';
import { decrypt, encrypt, type EncryptedBytes } from '../crypto/aead.js';
import { malformed, notAVault, tampered, tooLarge, unsupportedVersion } from '../crypto/errors.js';
import type { SecretBytes } from '../crypto/secret.js';
import { parseHeader, serialiseHeader } from './header.js';

/**
 * The KEEP container: the byte layout of a `.keep` file.
 *
 *   offset  content
 *   0       MAGIC "KEYHOLD\0"                            8 bytes
 *   8       formatVersion                                uint16 LE
 *   10      headerLength                                 uint32 LE
 *   14      HEADER (UTF-8 JSON, plaintext, used as AAD)
 *   …       bodyLength uint32 · nonce 12 · ciphertext+tag        ← all records
 *   …       chunkCount uint32
 *             repeated: chunkId 16 · length uint32 · nonce 12 · ct+tag   ← one attachment each
 *
 * Two design points worth stating, because both look like extra work until they are
 * needed:
 *
 * **Attachments are separate chunks, not part of the body.** Embedding them would mean
 * every unlock decrypts every attachment, and base64-in-JSON would add 33% to the file
 * for nothing. As separate chunks the records body stays small and fast to open, and a
 * 20 MB PDF is only touched when someone actually opens it — while the vault is still a
 * single portable file, which is the whole transfer story (decision D15).
 *
 * **The plaintext header is the AAD for the body.** It must be readable before any key
 * exists, so it cannot be encrypted; passing it as AAD means altering the KDF parameters,
 * the generation counter, or the wrapped key breaks the body's tag. Integrity without
 * confidentiality, which is precisely what AAD is for.
 *
 * The format is documented for third-party implementers in `docs/04-Vault-Format/`.
 */

/** Bounds-checked cursor. Every read goes through this, so truncation is caught once. */
class Reader {
  #offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.bytes.length - this.#offset;
  }

  take(length: number, what: string): Uint8Array {
    if (length < 0) throw malformed(`negative length for ${what}`);
    if (length > this.remaining) {
      throw malformed(
        `truncated while reading ${what}: needed ${length} bytes, only ${this.remaining} remain`
      );
    }
    const slice = this.bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return slice;
  }

  uint16(what: string): number {
    return Buffer.from(this.take(VERSION_FIELD_BYTES, what)).readUInt16LE(0);
  }

  uint32(what: string): number {
    return Buffer.from(this.take(LENGTH_FIELD_BYTES, what)).readUInt32LE(0);
  }
}

function uint16LE(value: number): Uint8Array {
  const buf = Buffer.allocUnsafe(VERSION_FIELD_BYTES);
  buf.writeUInt16LE(value, 0);
  return new Uint8Array(buf);
}

function uint32LE(value: number): Uint8Array {
  const buf = Buffer.allocUnsafe(LENGTH_FIELD_BYTES);
  buf.writeUInt32LE(value, 0);
  return new Uint8Array(buf);
}

/** nonce ‖ ciphertext ‖ tag — the on-disk shape of one encrypted region. */
function packSealed(sealed: EncryptedBytes): Uint8Array {
  return new Uint8Array(
    Buffer.concat([sealed.nonce, sealed.ciphertext, sealed.tag].map((b) => Buffer.from(b)))
  );
}

function unpackSealed(bytes: Uint8Array, what: string): EncryptedBytes {
  const minimum = NONCE_BYTES + TAG_BYTES;
  if (bytes.length < minimum) {
    throw malformed(`${what} is ${bytes.length} bytes, below the ${minimum}-byte minimum`);
  }
  return {
    nonce: bytes.subarray(0, NONCE_BYTES),
    ciphertext: bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES),
    tag: bytes.subarray(bytes.length - TAG_BYTES),
  };
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * Serialises a whole vault to the bytes that go on disk.
 *
 * Pure: it takes bytes and keys and returns bytes. All filesystem concerns — atomic
 * replacement, backups, crash recovery — live in `../vault/atomic-write.ts`, so this can
 * be tested exhaustively without touching a disk.
 */
export function writeContainer(
  header: KeepHeader,
  contents: VaultContents,
  dek: SecretBytes
): Uint8Array {
  const headerBytes = serialiseHeader({ ...header, formatVersion: FORMAT_VERSION });

  // Compress before encrypting. The reverse accomplishes nothing — ciphertext is
  // incompressible by construction.
  const compressedBody = gzipSync(Buffer.from(contents.body));
  const sealedBody = encrypt(dek, new Uint8Array(compressedBody), headerBytes);

  const parts: Uint8Array[] = [
    MAGIC,
    uint16LE(FORMAT_VERSION),
    uint32LE(headerBytes.length),
    headerBytes,
  ];

  const bodyBlob = packSealed(sealedBody);
  parts.push(uint32LE(bodyBlob.length), bodyBlob);

  parts.push(uint32LE(contents.attachments.length));
  for (const attachment of contents.attachments) {
    const id = Buffer.from(attachment.id, 'hex');
    if (id.length !== CHUNK_ID_BYTES) {
      throw malformed(
        `attachment id must be ${CHUNK_ID_BYTES * 2} hex characters, got "${attachment.id}"`
      );
    }

    // Each chunk is bound to its own id as AAD, so chunks cannot be swapped between
    // records by an attacker who can edit the file: a valid chunk moved to a different
    // id fails authentication.
    const sealedChunk = encrypt(dek, attachment.data, id);
    const chunkBlob = packSealed(sealedChunk);
    parts.push(new Uint8Array(id), uint32LE(chunkBlob.length), chunkBlob);
  }

  return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface ContainerPreamble {
  readonly header: KeepHeader;
  /** Byte offset where the body length field begins. */
  readonly bodyOffset: number;
  /** The exact header bytes, which are the AAD. Kept so we never re-serialise to verify. */
  readonly headerBytes: Uint8Array;
}

/**
 * Reads magic, version and header — everything obtainable without the password.
 *
 * Split out from `readContainer` because several operations legitimately need it: the
 * unlock screen shows the KDF parameters and needs the wrapped key; the sync engine
 * compares generation counters without unlocking anything.
 */
export function readPreamble(bytes: Uint8Array): ContainerPreamble {
  const reader = new Reader(bytes);

  const magic = reader.take(MAGIC_LENGTH, 'the file signature');
  if (!magic.every((byte, index) => byte === MAGIC[index])) throw notAVault();

  const version = reader.uint16('the format version');
  if (version > FORMAT_VERSION) throw unsupportedVersion(version, FORMAT_VERSION);
  if (version < 1) throw malformed(`format version ${version} is not valid`);

  const headerLength = reader.uint32('the header length');
  const headerBytes = reader.take(headerLength, 'the header');
  const header = parseHeader(headerBytes);

  if (header.formatVersion !== version) {
    // The version appears twice by design — once in the fixed preamble so it can be read
    // without parsing JSON, once inside the authenticated header. Disagreement means the
    // preamble was edited.
    throw malformed(
      `format version mismatch: the file preamble says ${version}, the header says ${header.formatVersion}`
    );
  }

  return { header, bodyOffset: reader.offset, headerBytes };
}

/**
 * Fully decrypts a container.
 *
 * `dek` must already have been unwrapped from `header.wrappedDek` — this function does
 * not know about passwords. Keeping key derivation out of here is what lets the same
 * code path serve unlock, re-key, and biometric unlock without branching.
 */
export function readContainer(bytes: Uint8Array, dek: SecretBytes): VaultContents {
  const { header, bodyOffset, headerBytes } = readPreamble(bytes);
  const reader = new Reader(bytes.subarray(bodyOffset));

  const bodyLength = reader.uint32('the body length');
  if (bodyLength > MAX_BODY_BYTES) throw tooLarge('the vault body', bodyLength, MAX_BODY_BYTES);
  const bodyBlob = reader.take(bodyLength, 'the vault body');

  let body: Uint8Array;
  try {
    const compressed = decrypt(dek, unpackSealed(bodyBlob, 'the vault body'), headerBytes);
    body = new Uint8Array(gunzipSync(Buffer.from(compressed), { maxOutputLength: MAX_BODY_BYTES }));
  } catch {
    // The DEK already unwrapped successfully, so the password was right. A failure here
    // means the body or the header was altered after the file was written.
    throw tampered('the vault body');
  }

  const chunkCount = reader.uint32('the attachment count');
  const attachments: AttachmentChunk[] = [];

  for (let index = 0; index < chunkCount; index += 1) {
    const idBytes = reader.take(CHUNK_ID_BYTES, `attachment ${index} id`);
    const id = Buffer.from(idBytes).toString('hex');

    const chunkLength = reader.uint32(`attachment ${index} length`);
    if (chunkLength > MAX_CHUNK_BYTES) {
      throw tooLarge(`attachment ${id}`, chunkLength, MAX_CHUNK_BYTES);
    }
    const chunkBlob = reader.take(chunkLength, `attachment ${id}`);

    try {
      const data = decrypt(dek, unpackSealed(chunkBlob, `attachment ${id}`), idBytes);
      attachments.push({ id, data });
    } catch {
      throw tampered(`attachment ${id}`);
    }
  }

  if (attachments.length !== header.attachmentCount) {
    throw malformed(
      `the header declares ${header.attachmentCount} attachments but the file contains ${attachments.length}`
    );
  }

  return { body, attachments };
}
