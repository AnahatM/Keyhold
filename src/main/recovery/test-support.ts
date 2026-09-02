// SPDX-License-Identifier: GPL-3.0-or-later
import {
  CIPHER_ID,
  FORMAT_VERSION,
  KDF_ID,
  MAGIC_LENGTH,
  VERSION_FIELD_BYTES,
  type KeepHeader,
} from '@shared/format/types.js';
import { writeContainer } from '../format/container.js';
import { SecretBytes } from '../crypto/secret.js';

/**
 * Damaged containers, built by breaking a **real** one.
 *
 * The whole point of `inspectVaultFile` is to say where a file stops being readable, and a
 * hand-assembled byte array proves nothing about that: it would test the fixture's idea of
 * the layout rather than the writer's. So every fixture here starts at `writeContainer` —
 * the same function that produces the files users actually have — and then removes or
 * overwrites specific bytes. If the format changes, these fixtures change with it for free,
 * and a test that has quietly stopped describing the real layout is not possible.
 *
 * Nothing here touches a disk or a clock. The key is a fixed pattern rather than a random
 * one because a fixture that differs between runs makes a failure unreproducible; it is not
 * key material, guards nothing, and never leaves this file.
 */

/** Deterministic stand-in for a DEK. Not security material — it seals fixture bytes only. */
export function fixtureDek(): SecretBytes {
  return SecretBytes.adopt(new Uint8Array(32).fill(0x2a));
}

/** Base64 of `length` bytes of a fixed pattern. The header only ever checks it decodes. */
function patternBase64(length: number, fill: number): string {
  return Buffer.from(new Uint8Array(length).fill(fill)).toString('base64');
}

export const FIXTURE_VAULT_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_DEVICE_ID = '22222222-2222-4222-8222-222222222222';

/** Epoch ms used by every fixture, so a report renders identically on every run. */
export const FIXTURE_NOW = 1_700_000_000_000;

export function fixtureHeader(overrides: Partial<KeepHeader> = {}): KeepHeader {
  return {
    formatVersion: FORMAT_VERSION,
    vaultId: FIXTURE_VAULT_ID,
    deviceId: FIXTURE_DEVICE_ID,
    kdf: {
      alg: KDF_ID,
      memoryKib: 65_536,
      iterations: 3,
      parallelism: 4,
      salt: patternBase64(16, 0x11),
    },
    cipher: CIPHER_ID,
    wrappedDek: {
      nonce: patternBase64(12, 0x22),
      ciphertext: patternBase64(32, 0x33),
      tag: patternBase64(16, 0x44),
    },
    createdAt: FIXTURE_NOW - 86_400_000,
    modifiedAt: FIXTURE_NOW,
    generation: 214,
    recordCount: 3,
    attachmentCount: 0,
    ...overrides,
  };
}

export interface ContainerOptions {
  readonly header?: Partial<KeepHeader>;
  readonly body?: Uint8Array;
  /** Chunk ids must be 32 hex characters; the writer refuses anything else. */
  readonly attachments?: readonly { readonly id: string; readonly data: Uint8Array }[];
}

/** A structurally perfect `.keep`, straight from the writer. */
export function buildContainer(options: ContainerOptions = {}): Uint8Array {
  const attachments = options.attachments ?? [];
  const header = fixtureHeader({
    attachmentCount: attachments.length,
    ...options.header,
  });
  const dek = fixtureDek();
  try {
    return writeContainer(
      header,
      { body: options.body ?? Buffer.from('{"documentVersion":1}', 'utf8'), attachments },
      dek
    );
  } finally {
    dek.destroy();
  }
}

/** A 32-hex-character chunk id built from one repeated nibble. */
export function chunkId(nibble: string): string {
  return nibble.repeat(32);
}

// ── The damage ───────────────────────────────────────────────────────────────

/** Everything after `length` removed — an interrupted write, or a truncated sync. */
export function truncatedTo(bytes: Uint8Array, length: number): Uint8Array {
  return bytes.slice(0, length);
}

/** One region overwritten in place, leaving the length alone. */
export function overwrittenAt(
  bytes: Uint8Array,
  offset: number,
  replacement: Uint8Array
): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy.set(replacement, offset);
  return copy;
}

/** A little-endian uint32 written over four bytes — how a length field gets corrupted. */
export function withUint32At(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const field = Buffer.alloc(4);
  field.writeUInt32LE(value, 0);
  return overwrittenAt(bytes, offset, new Uint8Array(field));
}

/** A little-endian uint16, for the two-byte version field. */
export function withUint16At(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const field = Buffer.alloc(2);
  field.writeUInt16LE(value, 0);
  return overwrittenAt(bytes, offset, new Uint8Array(field));
}

/** Extra bytes stuck on the end — two files concatenated, or a partial overwrite. */
export function withTrailing(bytes: Uint8Array, count: number): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from(bytes), Buffer.alloc(count, 0x5a)]));
}

// ── Offsets, derived rather than restated ────────────────────────────────────

/** Where the preamble's version field sits. Fixed by the format. */
export const VERSION_OFFSET = MAGIC_LENGTH;

/** Where the header-length field sits. */
export const HEADER_LENGTH_OFFSET = MAGIC_LENGTH + VERSION_FIELD_BYTES;

/** Where the header's own bytes begin. */
export const HEADER_OFFSET = MAGIC_LENGTH + VERSION_FIELD_BYTES + 4;

/** Reads the header length out of a container, so a test never hardcodes it. */
export function headerLengthOf(bytes: Uint8Array): number {
  return Buffer.from(bytes).readUInt32LE(HEADER_LENGTH_OFFSET);
}

/** Where the body-length field begins, for this container. */
export function bodyLengthOffsetOf(bytes: Uint8Array): number {
  return HEADER_OFFSET + headerLengthOf(bytes);
}

/** Where the body's sealed bytes begin. */
export function bodyOffsetOf(bytes: Uint8Array): number {
  return bodyLengthOffsetOf(bytes) + 4;
}

/** Reads the declared body length. */
export function bodyLengthOf(bytes: Uint8Array): number {
  return Buffer.from(bytes).readUInt32LE(bodyLengthOffsetOf(bytes));
}

/** Where the attachment-count field begins. */
export function chunkCountOffsetOf(bytes: Uint8Array): number {
  return bodyOffsetOf(bytes) + bodyLengthOf(bytes);
}
