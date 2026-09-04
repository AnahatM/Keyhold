// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto/errors.js';
import { ByteReader, ByteWriter } from './binary.js';

/**
 * The byte cursor, and the two things it exists to make impossible.
 *
 * **Reading past the end**, because every length in a KDBX file is a number the file chose.
 * And **writing into a buffer that has already been replaced**, which is the growth bug the
 * tests in the second block below were written for.
 *
 * ## The growth bug, and why it is worth a whole describe block
 *
 * `ByteWriter` shipped with every method written as `this.#view.setUint32(this.#room(4), …)`.
 * That reads correctly and is wrong: JavaScript resolves the `this.#view.setUint32` reference,
 * receiver included, **before** evaluating the arguments — so when `#room` grows the buffer,
 * the write lands on the discarded one. A code review caught it in `bytes()`, where it throws
 * loudly; the numeric methods had the same bug and were silent, which is worse.
 *
 * Every case below crosses the initial 256-byte capacity deliberately, because the bug is
 * invisible under it — the original file's own first users wrote small headers and never saw
 * it. **A test that stays inside the initial capacity is a test that cannot catch this.**
 *
 * Fault injection performed: each method restored to the one-line form. `bytes()` fails with
 * `RangeError: offset is out of bounds`; every numeric method fails on the round trip with
 * zeroes where the value should be. Both pasted into the commit.
 */

describe('reading', () => {
  it('reads little-endian values in order', () => {
    const bytes = new ByteWriter().u8(1).u16(2).u32(3).u64(4n).finish();
    const reader = new ByteReader(bytes);

    expect(reader.u8()).toBe(1);
    expect(reader.u16()).toBe(2);
    expect(reader.u32()).toBe(3);
    expect(reader.u64()).toBe(4n);
    expect(reader.done).toBe(true);
  });

  it('is genuinely little-endian, not merely self-consistent', () => {
    // Asserted against the bytes rather than against a round trip. A big-endian writer paired
    // with a big-endian reader round-trips perfectly and produces a file KeePass cannot read.
    expect([...new ByteWriter().u32(0x01_02_03_04).finish()]).toEqual([4, 3, 2, 1]);
    expect(new ByteReader(new Uint8Array([4, 3, 2, 1])).u32()).toBe(0x01_02_03_04);
  });

  it('keeps a 64-bit value exact', () => {
    // The reason `u64` is a bigint. This value is past `Number.MAX_SAFE_INTEGER`, and a
    // reader that narrowed to `number` would return a different, plausible-looking one.
    const huge = 2n ** 63n + 12_345n;
    expect(new ByteReader(new ByteWriter().u64(huge).finish()).u64()).toBe(huge);
  });

  it('refuses to read past the end, with a sentence rather than a RangeError', () => {
    const reader = new ByteReader(new Uint8Array([1, 2]));
    expect(() => reader.u32('a length')).toThrow(VaultError);
    expect(() => reader.u32('a length')).toThrow(/ends part-way through a length/);
  });

  it('refuses a negative count', () => {
    // Reachable from a signed length in a hostile file, and `slice(-4)` would return real
    // bytes from the wrong end rather than failing.
    expect(() => new ByteReader(new Uint8Array(8)).bytes(-4)).toThrow(VaultError);
  });

  it('copies rather than viewing, so zeroing a key does not scribble on the file', () => {
    const file = new Uint8Array([1, 2, 3, 4]);
    const taken = new ByteReader(file).bytes(4);
    taken.fill(0);

    expect([...file]).toEqual([1, 2, 3, 4]);
  });

  it('copies out of a Node Buffer too, which is the case that was broken', () => {
    // The case above passed while this one failed, and the gap shipped a real bug.
    // `Uint8Array.prototype.slice` copies; **`Buffer.prototype.slice` returns a view**. Every
    // decompressed KDBX payload is a Buffer — `gunzipSync` and `node:crypto` both return one —
    // so the inner-stream key came back as a window onto the payload, and the caller zeroing
    // the payload zeroed the key. Every protected value then decrypted to noise, from a file
    // that was byte-for-byte correct.
    const payload = Buffer.from([1, 2, 3, 4]);
    const taken = new ByteReader(payload).bytes(4);
    payload.fill(0);

    expect([...taken]).toEqual([1, 2, 3, 4]);
  });

  it('reports what has been consumed, for hashing a header in place', () => {
    const reader = new ByteReader(new Uint8Array([1, 2, 3, 4, 5]));
    reader.bytes(3);
    expect([...reader.consumed()]).toEqual([1, 2, 3]);
    expect(reader.remaining).toBe(2);
  });
});

describe('writing across a buffer growth', () => {
  /** Past the 256-byte initial capacity. Below it, the bug this block exists for is invisible. */
  const PAST_CAPACITY = 300;

  it('keeps every numeric value written across a growth', () => {
    const writer = new ByteWriter();
    for (let index = 0; index < PAST_CAPACITY; index += 1) writer.u32(index);

    const reader = new ByteReader(writer.finish());
    for (let index = 0; index < PAST_CAPACITY; index += 1) {
      expect(reader.u32(), `value ${String(index)} was lost to a reallocation`).toBe(index);
    }
  });

  it('keeps a byte array appended across a growth', () => {
    // The case that threw. The first append fits; the second forces the buffer to double, and
    // the buggy version wrote it into the buffer that had just been thrown away.
    const writer = new ByteWriter().bytes(new Uint8Array(200).fill(7));
    writer.bytes(new Uint8Array(200).fill(9));

    const written = writer.finish();
    expect(written).toHaveLength(400);
    expect(written[199]).toBe(7);
    expect(written[200]).toBe(9);
    expect(written[399]).toBe(9);
  });

  it('handles a single append far larger than the whole buffer', () => {
    // `#room` doubles in a loop rather than once, and a payload block is a megabyte. One
    // doubling would leave the buffer too small and the `set` would throw.
    const big = new Uint8Array(1_000_000).fill(3);
    const written = new ByteWriter().u8(1).bytes(big).finish();

    expect(written).toHaveLength(1_000_001);
    expect(written[1_000_000]).toBe(3);
  });

  it('reports its length as it grows', () => {
    const writer = new ByteWriter();
    expect(writer.length).toBe(0);
    writer.u32(1).bytes(new Uint8Array(500));
    expect(writer.length).toBe(504);
    expect(writer.finish()).toHaveLength(504);
  });
});
