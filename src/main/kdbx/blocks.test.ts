// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto/errors.js';
import { ByteReader, ByteWriter } from './binary.js';
import { BLOCK_OVERHEAD_BYTES, blockKey, readBlocks, writeBlocks } from './blocks.js';
import { HEADER_HMAC_INDEX, MAX_BLOCK } from './types.js';

/**
 * The HMAC block stream is the only thing standing between a KeePass database and an attacker
 * with write access to the file, so these tests are written as that attacker: flip a bit, move
 * a block, cut the tail off, lie about a length.
 *
 * Two of them exist specifically because a plausible-looking implementation passes everything
 * else and fails them — the second-block tamper (an implementation that authenticates only the
 * first block), and the block swap (one that leaves the index out of the HMAC input). If either
 * is ever deleted as redundant, the coverage that matters goes with it.
 *
 * A fixed key rather than a random one: these are byte-exact structural assertions, and a
 * random key would make a failure irreproducible without adding any strength to the test.
 */
const KEY = new Uint8Array(32).map((_, i) => (i * 7 + 13) & 0xff);

/** Deterministic filler, so a failure names the same byte on every run. */
const payloadOf = (length: number): Uint8Array =>
  new Uint8Array(length).map((_, i) => (i * 31 + 5) & 0xff);

/** Flips the low bit of one byte, returning a copy. The canonical corruption probe. */
const flipBit = (bytes: Uint8Array, index: number): Uint8Array => {
  const copy = Uint8Array.from(bytes);
  copy[index] = (copy[index] ?? 0) ^ 0b0000_0001;
  return copy;
};

const roundTrip = (payload: Uint8Array, blockSize?: number): Uint8Array =>
  readBlocks(new ByteReader(writeBlocks(payload, KEY, blockSize)), KEY);

/** The code of the `VaultError` a thunk throws, or a readable failure if it throws nothing. */
const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof VaultError) return error.code;
    return `threw a non-VaultError: ${String(error)}`;
  }
  return 'did not throw';
};

describe('blockKey', () => {
  it('is deterministic and differs for adjacent indices', () => {
    expect(blockKey(KEY, 7n)).toEqual(blockKey(KEY, 7n));
    expect(blockKey(KEY, 7n)).not.toEqual(blockKey(KEY, 8n));
    expect(blockKey(KEY, 0n)).not.toEqual(blockKey(KEY, 1n));

    // SHA-512, whole. Truncating it would still "work" and would still be a format change.
    expect(blockKey(KEY, 0n)).toHaveLength(64);
  });

  it('depends on the key as well as the index', () => {
    const other = new Uint8Array(32).fill(1);
    expect(blockKey(KEY, 0n)).not.toEqual(blockKey(other, 0n));
  });

  it('accepts the header index at the top of the 64-bit range', () => {
    // The index the outer header's own HMAC uses. Taken from `types.ts` rather than re-typed,
    // so a change there cannot leave this test agreeing with a value nothing else uses.
    const header = blockKey(KEY, HEADER_HMAC_INDEX);
    expect(header).toHaveLength(64);
    expect(header).not.toEqual(blockKey(KEY, 0n));
  });
});

describe('readBlocks / writeBlocks round trip', () => {
  const cases: readonly (readonly [string, number, number])[] = [
    ['an empty payload', 0, 16],
    ['a payload smaller than one block', 9, 16],
    ['a payload of exactly one block', 16, 16],
    ['a payload spanning three blocks', 48, 16],
    ['a payload spanning three blocks with a ragged last one', 41, 16],
  ];

  for (const [what, length, blockSize] of cases) {
    it(`survives ${what}`, () => {
      const payload = payloadOf(length);
      expect(roundTrip(payload, blockSize)).toEqual(payload);
    });
  }

  it('uses the default 1 MiB block size when none is given', () => {
    const payload = payloadOf(1000);
    const stream = writeBlocks(payload, KEY);

    // One data block plus one terminator — proof the default is not something tiny.
    expect(stream.length).toBe(payload.length + 2 * BLOCK_OVERHEAD_BYTES);
    expect(readBlocks(new ByteReader(stream), KEY)).toEqual(payload);
  });

  it('leaves the reader positioned after the terminator, not at the tail', () => {
    const payload = payloadOf(48);
    const stream = writeBlocks(payload, KEY, 16);
    const trailer = new Uint8Array([0xde, 0xad]);

    const reader = new ByteReader(new Uint8Array([...stream, ...trailer]));
    expect(readBlocks(reader, KEY)).toEqual(payload);
    expect(reader.rest()).toEqual(trailer);
  });

  it('refuses a stream written under a different key', () => {
    const stream = writeBlocks(payloadOf(48), KEY, 16);
    expect(codeOf(() => readBlocks(new ByteReader(stream), new Uint8Array(32).fill(9)))).toBe(
      'TAMPERED'
    );
  });
});

describe('readBlocks rejects tampering', () => {
  /** 48 bytes at a 16-byte block size: three data blocks plus a terminator. */
  const stream = (): Uint8Array => writeBlocks(payloadOf(48), KEY, 16);

  /** Byte offset of block `n`'s tag, its length field, and its data, at a 16-byte block size. */
  const blockAt = (n: number): number => n * (BLOCK_OVERHEAD_BYTES + 16);

  it('catches a flipped bit in the first block’s data', () => {
    const bad = flipBit(stream(), blockAt(0) + BLOCK_OVERHEAD_BYTES);
    expect(codeOf(() => readBlocks(new ByteReader(bad), KEY))).toBe('TAMPERED');
  });

  it('catches a flipped bit in the second block’s data', () => {
    // The one that matters: an implementation that verifies only the first block, or that
    // stops verifying once it has a plausible amount of payload, passes the test above and
    // fails this one.
    const bad = flipBit(stream(), blockAt(1) + BLOCK_OVERHEAD_BYTES + 3);
    expect(codeOf(() => readBlocks(new ByteReader(bad), KEY))).toBe('TAMPERED');
  });

  it('catches a flipped bit in the third block’s data', () => {
    const bad = flipBit(stream(), blockAt(2) + BLOCK_OVERHEAD_BYTES + 15);
    expect(codeOf(() => readBlocks(new ByteReader(bad), KEY))).toBe('TAMPERED');
  });

  it('catches a flipped bit in a tag', () => {
    const bad = flipBit(stream(), blockAt(1) + 31);
    expect(codeOf(() => readBlocks(new ByteReader(bad), KEY))).toBe('TAMPERED');
  });

  it('catches a flipped bit in a length field', () => {
    // 16 becomes 17. The bytes are still there to read, so this cannot be caught by bounds
    // checking — only the length being inside the HMAC catches it.
    const bad = flipBit(stream(), blockAt(0) + 32);
    expect(codeOf(() => readBlocks(new ByteReader(bad), KEY))).toBe('TAMPERED');
  });

  it('catches two whole blocks being swapped', () => {
    // Every tag here is genuine; only the positions changed. This is what the index in the
    // HMAC input is for, and an implementation that omitted it passes every other test above.
    const original = stream();
    const size = BLOCK_OVERHEAD_BYTES + 16;
    const swapped = Uint8Array.from(original);
    swapped.set(original.subarray(blockAt(1), blockAt(1) + size), blockAt(0));
    swapped.set(original.subarray(blockAt(0), blockAt(0) + size), blockAt(1));

    expect(swapped).not.toEqual(original);
    expect(codeOf(() => readBlocks(new ByteReader(swapped), KEY))).toBe('TAMPERED');
  });

  it('catches a whole block being duplicated over its neighbour', () => {
    const original = stream();
    const size = BLOCK_OVERHEAD_BYTES + 16;
    const replayed = Uint8Array.from(original);
    replayed.set(original.subarray(blockAt(0), blockAt(0) + size), blockAt(1));

    expect(codeOf(() => readBlocks(new ByteReader(replayed), KEY))).toBe('TAMPERED');
  });

  it('names the block and the offset but never the key or the payload', () => {
    const bad = flipBit(stream(), blockAt(1) + BLOCK_OVERHEAD_BYTES);
    let message = '';
    try {
      readBlocks(new ByteReader(bad), KEY);
    } catch (error) {
      message = (error as VaultError).message;
    }

    expect(message).toContain('block 1');
    // Hard rule 1: no key material and no payload bytes in a refusal, in any encoding.
    expect(message).not.toContain(Buffer.from(KEY).toString('hex'));
    expect(message).not.toContain(Buffer.from(blockKey(KEY, 1n)).toString('hex'));
    expect(message).not.toContain(Buffer.from(payloadOf(48)).toString('hex'));
    expect(message).not.toMatch(/[0-9a-f]{16}/i);
  });
});

describe('readBlocks rejects truncation', () => {
  /** Where block 1 begins, at a 16-byte block size. */
  const SECOND_BLOCK_AT = BLOCK_OVERHEAD_BYTES + 16;

  it('refuses a stream whose terminating block was removed', () => {
    // The blocks that remain all authenticate perfectly. Nothing but the missing terminator
    // says the database was cut short — which is the entire reason the terminator exists.
    const full = writeBlocks(payloadOf(48), KEY, 16);
    const cut = full.subarray(0, full.length - BLOCK_OVERHEAD_BYTES);

    expect(codeOf(() => readBlocks(new ByteReader(cut), KEY))).toBe('MALFORMED');
  });

  it('refuses an empty stream, which is a payload-less file with no terminator', () => {
    expect(codeOf(() => readBlocks(new ByteReader(new Uint8Array(0)), KEY))).toBe('MALFORMED');
  });

  it('refuses a stream cut in the middle of a block’s data', () => {
    const full = writeBlocks(payloadOf(48), KEY, 16);
    const cut = full.subarray(0, SECOND_BLOCK_AT + 40);
    expect(codeOf(() => readBlocks(new ByteReader(cut), KEY))).toBe('MALFORMED');
  });

  it('refuses a stream cut in the middle of a tag', () => {
    const full = writeBlocks(payloadOf(48), KEY, 16);
    const cut = full.subarray(0, SECOND_BLOCK_AT + 10);
    expect(codeOf(() => readBlocks(new ByteReader(cut), KEY))).toBe('MALFORMED');
  });

  it('refuses a truncation dressed up with a forged terminator', () => {
    // The attack the "verify, *then* check for zero" ordering exists to stop: cut the last
    // block off and staple on 32 junk bytes and four zeros, and a reader that treats a
    // zero-length block as the end before authenticating it reports a clean, complete database
    // that is missing its tail. Without this case, that reordering passes every other test here.
    const full = writeBlocks(payloadOf(48), KEY, 16);
    // Drop the real terminator and the last data block, leaving blocks 0 and 1 intact.
    const truncated = full.subarray(0, full.length - 2 * BLOCK_OVERHEAD_BYTES - 16);
    const forged = new Uint8Array([...truncated, ...new Uint8Array(BLOCK_OVERHEAD_BYTES)]);

    expect(codeOf(() => readBlocks(new ByteReader(forged), KEY))).toBe('TAMPERED');
  });
});

describe('readBlocks refuses declared sizes before allocating', () => {
  /** A single block whose tag is meaningless — the size check must fire before the tag is used. */
  const claiming = (length: number): Uint8Array =>
    new ByteWriter().bytes(new Uint8Array(32)).u32(length).finish();

  it('refuses an oversized declared length with TOO_LARGE', () => {
    // Note there are *no data bytes* after the length here. If the ceiling were checked after
    // the read, this would surface as MALFORMED ("the file ends part-way through…") — which is
    // exactly the mistake the assertion on the code is there to catch.
    expect(codeOf(() => readBlocks(new ByteReader(claiming(MAX_BLOCK + 1)), KEY))).toBe(
      'TOO_LARGE'
    );
  });

  it('refuses a block claiming most of the 32-bit range', () => {
    expect(codeOf(() => readBlocks(new ByteReader(claiming(0xff_ff_ff_ff)), KEY))).toBe(
      'TOO_LARGE'
    );
  });

  it('states the limit without leaking anything else', () => {
    let message = '';
    try {
      readBlocks(new ByteReader(claiming(MAX_BLOCK + 1)), KEY);
    } catch (error) {
      message = (error as VaultError).message;
    }
    expect(message).toContain(String(MAX_BLOCK));
    expect(message).not.toContain(Buffer.from(KEY).toString('hex'));
  });
});

describe('writeBlocks guards its own inputs', () => {
  it('rejects a block size that is not a usable integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, MAX_BLOCK + 1]) {
      expect(() => writeBlocks(payloadOf(4), KEY, bad)).toThrow(RangeError);
    }
  });

  it('accepts the extremes of the legal block size', () => {
    expect(roundTrip(payloadOf(3), 1)).toEqual(payloadOf(3));
    expect(roundTrip(payloadOf(3), MAX_BLOCK)).toEqual(payloadOf(3));
  });
});
