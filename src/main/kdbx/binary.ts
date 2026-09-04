// SPDX-License-Identifier: GPL-3.0-or-later
import { badKdbx } from './types.js';

/**
 * Little-endian reading and writing over a byte array, bounds-checked at every step.
 *
 * KDBX is a length-prefixed binary format written by somebody else, so every read is a read
 * of a number that a hostile file chose. The whole value of this file is that **no read can
 * run off the end and no length can be trusted**: a truncated file produces a refusal with a
 * sentence in it, never an out-of-range slice, a `NaN`, or a silent zero-filled buffer.
 *
 * `DataView` rather than `Buffer` methods for the same reason it is used elsewhere in this
 * repo: a `Buffer` view over a pooled allocation shares its `ArrayBuffer` with unrelated data,
 * and `byteOffset` arithmetic is one of the two ways that goes wrong. The other is forgetting
 * that `Buffer.readUInt32LE` throws a `RangeError` rather than the error a user should see.
 */

export class ByteReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  /** True once every byte has been read. */
  get done(): boolean {
    return this.remaining <= 0;
  }

  #need(count: number, what: string): number {
    if (count < 0 || this.remaining < count) {
      throw badKdbx(`the file ends part-way through ${what}`);
    }
    const at = this.#offset;
    this.#offset += count;
    return at;
  }

  u8(what = 'a byte'): number {
    return this.#view.getUint8(this.#need(1, what));
  }

  u16(what = 'a 16-bit value'): number {
    return this.#view.getUint16(this.#need(2, what), true);
  }

  u32(what = 'a 32-bit value'): number {
    return this.#view.getUint32(this.#need(4, what), true);
  }

  i32(what = 'a signed 32-bit value'): number {
    return this.#view.getInt32(this.#need(4, what), true);
  }

  /**
   * A 64-bit value as a `bigint`.
   *
   * Deliberately not narrowed to `number` here. Argon2's memory parameter is a 64-bit byte
   * count, and a file is free to claim 2^63 of them; converting first and checking second is
   * how a bounds check gets bypassed by a value that has already lost its precision.
   */
  u64(what = 'a 64-bit value'): bigint {
    return this.#view.getBigUint64(this.#need(8, what), true);
  }

  i64(what = 'a signed 64-bit value'): bigint {
    return this.#view.getBigInt64(this.#need(8, what), true);
  }

  /**
   * `count` bytes, as a **copy**.
   *
   * A copy rather than a subarray, and that is not caution for its own sake: several of these
   * slices become key material that is later zeroed, and a subarray would zero part of the
   * caller's file buffer instead — or, worse, would not, and would leave the key alive in a
   * buffer nobody thinks holds one.
   *
   * `new Uint8Array(subarray)` rather than `.slice()`, and the difference is a real bug this
   * had. `Uint8Array.prototype.slice` copies; **`Buffer.prototype.slice` overrides it and
   * returns a view**. Every decompressed payload in this folder is a `Buffer` — `gunzipSync`
   * and `node:crypto` both return one — so `.slice()` handed back a window onto the payload,
   * and the caller's `payload.fill(0)` then zeroed the inner-stream key it had just read.
   * The symptom was every protected value decrypting to noise, from a file that was correct.
   */
  bytes(count: number, what = 'data'): Uint8Array {
    const at = this.#need(count, what);
    return new Uint8Array(this.#bytes.subarray(at, at + count));
  }

  /** Everything from here to the end, as a copy. */
  rest(): Uint8Array {
    return this.bytes(this.remaining, 'the remainder of the file');
  }

  /** A read-only view of what has been consumed so far, for hashing a header in place. */
  consumed(): Uint8Array {
    return this.#bytes.subarray(0, this.#offset);
  }
}

/**
 * A growing little-endian byte buffer.
 *
 * Doubling rather than exact-fit reallocation: a KDBX header is written as a few dozen small
 * appends, and an exact-fit strategy copies the whole buffer on every one of them.
 */
export class ByteWriter {
  #bytes = new Uint8Array(256);
  #view = new DataView(this.#bytes.buffer);
  #length = 0;

  get length(): number {
    return this.#length;
  }

  #room(count: number): number {
    if (this.#length + count > this.#bytes.length) {
      let capacity = this.#bytes.length * 2;
      while (capacity < this.#length + count) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.#bytes.subarray(0, this.#length));
      this.#bytes = grown;
      this.#view = new DataView(grown.buffer);
    }
    const at = this.#length;
    this.#length += count;
    return at;
  }

  // Every method below reserves space **on its own line**, before touching `#view` or
  // `#bytes`. Writing `this.#view.setUint32(this.#room(4), …)` reads perfectly well and is
  // wrong: JavaScript resolves the `this.#view.setUint32` reference — and with it the
  // receiver — before evaluating the arguments, so if `#room` grows the buffer the write
  // lands on the **discarded** one. A code review found this in `bytes()`, where it throws
  // `RangeError: offset is out of bounds`; the numeric methods had it too and were quieter,
  // silently writing into a buffer that had already been replaced.

  u8(value: number): this {
    const at = this.#room(1);
    this.#view.setUint8(at, value);
    return this;
  }

  u16(value: number): this {
    const at = this.#room(2);
    this.#view.setUint16(at, value, true);
    return this;
  }

  u32(value: number): this {
    const at = this.#room(4);
    this.#view.setUint32(at, value, true);
    return this;
  }

  i32(value: number): this {
    const at = this.#room(4);
    this.#view.setInt32(at, value, true);
    return this;
  }

  u64(value: bigint | number): this {
    const at = this.#room(8);
    this.#view.setBigUint64(at, BigInt(value), true);
    return this;
  }

  i64(value: bigint | number): this {
    const at = this.#room(8);
    this.#view.setBigInt64(at, BigInt(value), true);
    return this;
  }

  bytes(value: Uint8Array): this {
    const at = this.#room(value.length);
    this.#bytes.set(value, at);
    return this;
  }

  /** The bytes written, as a copy of exactly `length` bytes. */
  finish(): Uint8Array {
    return this.#bytes.slice(0, this.#length);
  }
}
