// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { VaultError } from '../crypto/errors.js';
import { ByteWriter, type ByteReader } from './binary.js';
import { MAX_BLOCK, MAX_PAYLOAD, badKdbx, kdbxTooLarge } from './types.js';

/**
 * KDBX 4's HMAC block stream — the authenticated framing that wraps the encrypted payload.
 *
 * Everything after the outer header, its SHA-256 and its HMAC is a sequence of blocks:
 *
 *   32 bytes   HMAC-SHA256(blockKey(i), uint64LE(i) ‖ uint32LE(length) ‖ data)
 *    4 bytes   length, uint32 LE
 *   `length`   data
 *
 * and a block whose length is zero terminates the stream. **That terminator is not a
 * formality.** Its HMAC covers a zero length at a known index, so it is the one thing in the
 * file that says "this is where the database ends" in a way an attacker cannot forge. A reader
 * that stops at end-of-file instead of at the terminator accepts a database with its tail
 * lopped off — every block it did read authenticates perfectly, so nothing else in the format
 * would notice. Truncation is refused here or it is not refused at all.
 *
 * ## Why the index is in the HMAC
 *
 * Each block is keyed by `SHA-512(uint64LE(i) ‖ hmacKey)` *and* signs its own index, which is
 * belt and braces on purpose: without it, two blocks of a database could be swapped, deleted or
 * replayed and every individual tag would still verify. The index is what binds a block to its
 * position, and it is the reason `blocks.test.ts` swaps two whole blocks — a test that only
 * flips bits would pass an implementation that dropped the index entirely.
 *
 * ## Composition, not invention
 *
 * SHA-512, HMAC-SHA256 and the constant-time compare are all `node:crypto`. This file
 * implements KeePass's framing around them, which is a file format rather than cryptography.
 *
 * The header's own HMAC uses the same construction at `types.ts`'s `HEADER_HMAC_INDEX` — which
 * is why `blockKey` is exported rather than kept private to the stream loop, and why that index
 * is not redeclared here.
 */

/** Every block's tag is a full HMAC-SHA256. */
const BLOCK_HMAC_BYTES = 32;

/** The length prefix: uint32 LE, immediately after the tag. */
const BLOCK_LENGTH_BYTES = 4;

/** The framing one block costs on disk, before its data. A terminator is exactly this long. */
export const BLOCK_OVERHEAD_BYTES = BLOCK_HMAC_BYTES + BLOCK_LENGTH_BYTES;

/** 1 MiB — what KeePass writes. Not a format limit; `MAX_BLOCK` is the ceiling we read. */
export const DEFAULT_BLOCK_SIZE = 1024 * 1024;

/** `uint64LE(value)` as its own eight bytes. */
function uint64LE(value: bigint): Uint8Array {
  return new ByteWriter().u64(value).finish();
}

/**
 * `SHA-512(uint64LE(index) ‖ hmacKey)` — the key for one block, or for the header at
 * `HEADER_HMAC_INDEX`.
 *
 * Per-block keys rather than one key for the whole file: a tag computed under a key that only
 * exists for position `i` cannot be lifted into position `j`, whatever else an attacker
 * rewrites. The full 64-byte SHA-512 digest is the key — HMAC-SHA256 accepts keys longer than
 * its block size and hashes them down itself, and truncating to 32 here would be a
 * modification of somebody else's format, which is exactly the kind of "small improvement"
 * that makes a file KeePass cannot open.
 */
export function blockKey(hmacKey: Uint8Array, index: bigint): Uint8Array {
  const digest = createHash('sha512').update(uint64LE(index)).update(hmacKey).digest();
  return new Uint8Array(digest);
}

/** The HMAC one block should carry, given its index, its declared length and its data. */
function blockTag(hmacKey: Uint8Array, index: bigint, length: number, data: Uint8Array): Buffer {
  const prefix = new ByteWriter().u64(index).u32(length).finish();
  return createHmac('sha256', blockKey(hmacKey, index)).update(prefix).update(data).digest();
}

/**
 * The refusal for a block whose tag does not match.
 *
 * `TAMPERED`, never `MALFORMED`. The two codes say genuinely different things to the person
 * holding the file: malformed is "this is damaged", tampered is "this authenticated, keyed data
 * does not match its key" — and unlike a `.keep`'s wrapped DEK, a failure here cannot be a
 * mistyped password, because the HMAC key was already derived successfully from one that
 * worked. Telling someone their database is merely damaged when it has been edited under them
 * is the wrong sentence.
 *
 * The index and the offset are structural facts about the file and safe to name. Nothing keyed
 * or payload-derived goes near the message — see hard rule 1.
 */
function blockTampered(index: bigint, offset: number): VaultError {
  return new VaultError(
    'TAMPERED',
    `Authentication failed on block ${index} of this KeePass database, at byte ${offset}. ` +
      'The file has been modified or corrupted since it was written.'
  );
}

/**
 * Reads and verifies the whole block stream, returning the concatenated payload.
 *
 * The reader is left positioned immediately after the terminating block, so a caller that has
 * more file to parse can carry on from here.
 */
export function readBlocks(reader: ByteReader, hmacKey: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;

  for (let index = 0n; ; index += 1n) {
    if (reader.done) {
      // Not "ran out of bytes" — the stream is *supposed* to end, and it ends with a
      // terminating block, not with end-of-file. See the note at the top of this file.
      throw badKdbx(
        `the encrypted data ends after ${index} blocks without its terminating block, ` +
          'so the file is truncated'
      );
    }

    const at = reader.offset;
    const tag = reader.bytes(BLOCK_HMAC_BYTES, `the authentication tag of block ${index}`);
    const length = reader.u32(`the length of block ${index}`);

    // Both ceilings are checked *before* the read that would allocate on the strength of them.
    // A file is free to claim a four-gigabyte block; believing it for even one allocation is
    // the whole attack.
    if (length > MAX_BLOCK) {
      throw kdbxTooLarge(
        `a ${length}-byte block at index ${index}, above the ${MAX_BLOCK}-byte limit`
      );
    }
    if (total + length > MAX_PAYLOAD) {
      throw kdbxTooLarge(
        `more than ${MAX_PAYLOAD} bytes of encrypted data, reached at block ${index}`
      );
    }

    const data = reader.bytes(length, `the ${length} bytes of block ${index}`);

    // `timingSafeEqual`, not `Buffer.equals` and not a loop that returns on the first
    // difference. Either of those leaks, through how long it took, how many leading bytes of a
    // forged tag were right — which turns forgery from "guess 2^256" into "guess 32 bytes, one
    // byte at a time". The comparison must take the same time whether it fails at byte 0 or
    // byte 31.
    const expected = blockTag(hmacKey, index, length, data);
    if (!timingSafeEqual(expected, Buffer.from(tag))) throw blockTampered(index, at);

    // A verified zero-length block is the end of the stream, and only a *verified* one is —
    // checking the length first and the tag second would let a truncation be dressed up as a
    // clean ending by appending four zero bytes.
    if (length === 0) break;

    parts.push(data);
    total += length;
  }

  return new Uint8Array(
    Buffer.concat(
      parts.map((part) => Buffer.from(part)),
      total
    )
  );
}

/**
 * Writes `payload` as blocks of at most `blockSize` bytes, terminated correctly.
 *
 * The terminator is written unconditionally, including for an empty payload — a stream of zero
 * data blocks is still a stream, and it still has to be distinguishable from a file that was
 * cut off before its first block.
 */
export function writeBlocks(
  payload: Uint8Array,
  hmacKey: Uint8Array,
  blockSize: number = DEFAULT_BLOCK_SIZE
): Uint8Array {
  if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > MAX_BLOCK) {
    // Ours to get right, not a file's to claim — so this is a programming error, phrased for a
    // developer rather than surfaced to a user.
    throw new RangeError(`blockSize must be an integer in 1…${MAX_BLOCK}, got ${blockSize}`);
  }
  if (payload.length > MAX_PAYLOAD) {
    // Refused at the writer as well as the reader, so we can never produce a file that this
    // build would then refuse to open.
    throw kdbxTooLarge(`${payload.length} bytes of encrypted data to write, above ${MAX_PAYLOAD}`);
  }

  // Concatenated rather than appended through a `ByteWriter`, and that is a workaround, not a
  // preference: `ByteWriter.bytes` evaluates `this.#bytes` before `#room` reallocates it, so any
  // append that crosses the capacity boundary writes into the discarded buffer and throws
  // `RangeError: offset is out of bounds`. A megabyte block crosses it on the first call. The
  // fix belongs in `binary.ts`, which this file does not own; the fixed-size prefixes below the
  // block loop are small enough never to reach it. Reverse this once `ByteWriter` is fixed.
  const parts: Buffer[] = [];
  let index = 0n;

  for (let at = 0; at < payload.length; at += blockSize) {
    const data = payload.subarray(at, Math.min(at + blockSize, payload.length));
    parts.push(
      blockTag(hmacKey, index, data.length, data),
      lengthPrefix(data.length),
      Buffer.from(data)
    );
    index += 1n;
  }

  const empty = new Uint8Array(0);
  parts.push(blockTag(hmacKey, index, 0, empty), lengthPrefix(0));

  return new Uint8Array(Buffer.concat(parts));
}

/** One block's `uint32LE` length field. */
function lengthPrefix(length: number): Buffer {
  return Buffer.from(new ByteWriter().u32(length).finish());
}
