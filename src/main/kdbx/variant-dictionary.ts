// SPDX-License-Identifier: GPL-3.0-or-later
import { ByteReader, ByteWriter } from './binary.js';
import {
  badKdbx,
  kdbxTooLarge,
  MAX_HEADER_FIELD,
  type VariantDictionary,
  type VariantValue,
} from './types.js';

/**
 * KeePass's `VariantDictionary` — the little type-length-value map that carries a KDBX 4
 * file's KDF parameters, and therefore decides how the master key is derived.
 *
 * The shape is small enough to state in full. A `uint16` version, then a run of items, then a
 * `0x00` type byte that ends the run:
 *
 * ```
 *   uint16  version           high byte is major; 0x0100 is what KeePass writes
 *   ── per item ──
 *   uint8   type              0x04 UInt32 · 0x05 UInt64 · 0x08 Bool · 0x0C Int32
 *                             0x0D Int64 · 0x18 String · 0x42 ByteArray · 0x00 end
 *   uint32  key length        UTF-8 bytes follow
 *   uint32  value length      value bytes follow
 * ```
 *
 * Everything is little-endian, and everything is a number a file somebody else wrote chose.
 *
 * ## Why the refusals here are unusually strict
 *
 * This dictionary is not decoration around the interesting part of the file — it *is* the
 * interesting part. `S` is the Argon2 salt, `M` the memory cost, `I` the iterations, `P` the
 * parallelism. Getting any of them wrong does not produce a parse error further down; it
 * produces a **different key**, and a different key produces "wrong password" for a password
 * that is right. A user cannot debug that, cannot distinguish it from a typo, and will
 * conclude their database is lost.
 *
 * That single failure mode drives three decisions that would otherwise look like pedantry:
 *
 *  - **An unknown type byte is refused, never skipped.** The obvious "skip what you don't
 *    understand" reading of a TLV format is exactly wrong here: the thing skipped could be
 *    the parameter that mattered. A reader that does not understand a KDF parameter does not
 *    understand the KDF.
 *  - **A duplicate key is refused, not resolved.** Last-one-wins and first-one-wins are both
 *    defensible and KeePass implementations disagree; a file containing both `M=64MiB` and
 *    `M=1MiB` gets to pick which reader derives which key. Refusing means the question is
 *    never asked.
 *  - **A fixed-width type must declare its width.** A `UInt32` claiming three bytes is not a
 *    value this reader can round to the nearest sensible interpretation.
 *
 * ## Never quote a value (hard rule 1)
 *
 * `S` is a salt and `$UUID` identifies the KDF, but the format permits arbitrary keys and this
 * reader is also the one that will read a `PublicCustomData` dictionary later. Error messages
 * are logged, screenshotted and pasted into issue trackers, so a message here may name the
 * **key**, the **type byte** and the **offset** — never a single byte of a value. That is
 * enforced by a property test rather than by care: `variant-dictionary.test.ts` drives every
 * refusal in this file over a dictionary with a known salt and a known string, and asserts
 * that neither appears in any message, in any encoding.
 *
 * ## Bounds before allocations
 *
 * Every length is checked against `MAX_HEADER_FIELD` *before* the bytes behind it are read, so
 * a file declaring a four-gigabyte parameter name is refused with `TOO_LARGE` rather than
 * being allowed to attempt the allocation and fail as "damaged". Same reasoning, and the same
 * ceiling, as everything else in this folder.
 */

// ── On-disk constants ────────────────────────────────────────────────────────

/**
 * `0x0100` — major 1, minor 0. Written by KeePass 2 and by KeePassXC.
 *
 * Only the **major** half is a compatibility statement: the format's own rule is that a
 * reader may read any minor version of a major it knows, because a minor bump adds items
 * rather than changing framing. A major bump means the framing above is no longer true.
 */
const VARIANT_DICTIONARY_VERSION = 0x0100;
const SUPPORTED_MAJOR_VERSION = 1;

const TYPE_END = 0x00;
const TYPE_UINT32 = 0x04;
const TYPE_UINT64 = 0x05;
const TYPE_BOOL = 0x08;
const TYPE_INT32 = 0x0c;
const TYPE_INT64 = 0x0d;
const TYPE_STRING = 0x18;
const TYPE_BYTE_ARRAY = 0x42;

/** Widths the format fixes. A declared length that disagrees is a refusal, not a coercion. */
const WIDTH_BOOL = 1;
const WIDTH_32 = 4;
const WIDTH_64 = 8;

/** The inclusive bounds of the four integer tags, for the writer's narrowest-tag choice. */
const MAX_UINT32 = 0xffff_ffff;
const MIN_INT32 = -0x8000_0000;
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;
const MIN_INT64 = -0x8000_0000_0000_0000n;

/**
 * UTF-8, strictly, in both directions.
 *
 * `fatal` matters more than it looks: a lenient decode turns invalid bytes into U+FFFD, and a
 * key that silently became `S�` would not match the `S` the KDF reader looks for — so the
 * file would be reported as missing its salt rather than as malformed, which sends the user
 * looking in entirely the wrong place.
 */
const DECODER = new TextDecoder('utf-8', { fatal: true });
const ENCODER = new TextEncoder();

/** `0x1f`, for a message that names a type byte the way the constants above are written. */
function hex(byte: number): string {
  return `0x${byte.toString(16).padStart(2, '0')}`;
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Parses a `VariantDictionary` out of the bytes of one header field.
 *
 * The returned map is in file order, which the writer preserves — KeePass does not require an
 * order, but keeping the one the file used means a read/write cycle produces the same bytes
 * for the same input, and a diff of two exports stays readable.
 */
export function readVariantDictionary(bytes: Uint8Array): VariantDictionary {
  const reader = new ByteReader(bytes);

  const version = reader.u16('the parameter list version');
  const major = version >>> 8;
  if (major !== SUPPORTED_MAJOR_VERSION) {
    // Refused by name, in the same spirit as KDBX 3 in `types.ts`: "this is version 2 and
    // Keyhold reads version 1" is a sentence somebody can act on. Reading it anyway would
    // mean guessing at framing, and a wrong guess here derives a wrong key.
    throw badKdbx(
      `its KDF parameters use VariantDictionary format ${major}, and this reader understands format ${SUPPORTED_MAJOR_VERSION}`
    );
  }

  const dictionary = new Map<string, VariantValue>();

  for (;;) {
    const at = reader.offset;
    if (reader.done) {
      // Distinguished from a truncated item on purpose. "It stops without the byte that says
      // it stopped" is a different fault from "it stops half-way through a value", and the
      // two point at different kinds of damage.
      throw badKdbx(`the parameter list ends at byte ${at} without its terminating type byte`);
    }

    const type = reader.u8('a parameter type');
    if (type === TYPE_END) break;

    const key = readKey(reader, at);
    if (dictionary.has(key)) {
      throw badKdbx(`the parameter "${key}" is given more than once, again at byte ${at}`);
    }
    dictionary.set(key, readValue(reader, type, key, at));
  }

  // `reader.remaining` rather than `!reader.done`: TypeScript narrows the `done` getter to
  // `false` at the `break` above and keeps that narrowing here, because a getter looks like a
  // property to the compiler and nothing in the loop assigns to it. The negation would then be
  // statically always-true — which ESLint says out loud, and which is worth listening to.
  if (reader.remaining > 0) {
    // The caller hands this function the whole of one header field, and the terminator is the
    // end of the dictionary by definition. Bytes after it mean the file's framing and this
    // reader's disagree about where the dictionary stopped — and a second dictionary hidden
    // in that gap is exactly the ambiguity every other refusal in this file exists to avoid.
    throw badKdbx(
      `the parameter list has ${reader.remaining} further bytes after its terminating type byte`
    );
  }

  return dictionary;
}

/**
 * A declared length, refused before anything is allocated on the strength of it.
 *
 * `ByteReader.u32` is unsigned, so there is no negative-length case to consider here; the only
 * hostile input is a number that is honestly enormous. `what` is a phrase naming the *field* —
 * never its contents.
 */
function readLength(reader: ByteReader, what: string): number {
  const length = reader.u32(what);
  if (length > MAX_HEADER_FIELD) {
    throw kdbxTooLarge(`${what} as ${length} bytes, above the ${MAX_HEADER_FIELD}-byte limit`);
  }
  return length;
}

function readKey(reader: ByteReader, at: number): string {
  const what = `the name of the parameter at byte ${at}`;
  const length = readLength(reader, what);

  // A nameless parameter cannot be looked up, so it can only ever be ignored — which is the
  // silent-drop this file refuses to do anywhere else.
  if (length === 0) throw badKdbx(`the parameter at byte ${at} has an empty name`);

  const raw = reader.bytes(length, what);
  try {
    return DECODER.decode(raw);
  } catch {
    throw badKdbx(`the parameter at byte ${at} has a name that is not valid UTF-8`);
  }
}

function readValue(reader: ByteReader, type: number, key: string, at: number): VariantValue {
  const what = `the value of "${key}"`;
  const length = readLength(reader, what);

  switch (type) {
    case TYPE_UINT32:
      requireWidth(length, WIDTH_32, key, at, 'UInt32');
      return reader.u32(what);
    case TYPE_INT32:
      requireWidth(length, WIDTH_32, key, at, 'Int32');
      return reader.i32(what);
    case TYPE_UINT64:
      requireWidth(length, WIDTH_64, key, at, 'UInt64');
      return reader.u64(what);
    case TYPE_INT64:
      requireWidth(length, WIDTH_64, key, at, 'Int64');
      return reader.i64(what);
    case TYPE_BOOL:
      requireWidth(length, WIDTH_BOOL, key, at, 'Bool');
      // Any non-zero byte is true. KeePass writes 0 and 1, but the format says "a byte", and
      // refusing 2 would be this reader inventing a rule the writers do not follow.
      return reader.u8(what) !== 0;
    case TYPE_STRING: {
      const raw = reader.bytes(length, what);
      try {
        return DECODER.decode(raw);
      } catch {
        throw badKdbx(`the value of "${key}" at byte ${at} is not valid UTF-8`);
      }
    }
    case TYPE_BYTE_ARRAY:
      // `ByteReader.bytes` copies, which is what a salt wants: the caller may zero it, and a
      // subarray would be zeroing part of the file buffer instead.
      return reader.bytes(length, what);
    default:
      // The most important refusal in the file. See the header: a skipped parameter is a
      // wrong key reported as a wrong password.
      throw badKdbx(
        `the parameter "${key}" at byte ${at} has type ${hex(type)}, which is not a VariantDictionary type this reader knows`
      );
  }
}

function requireWidth(length: number, width: number, key: string, at: number, name: string): void {
  if (length === width) return;
  throw badKdbx(
    `the parameter "${key}" at byte ${at} is a ${name} but declares ${length} bytes rather than ${width}`
  );
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * Serialises a dictionary back to bytes.
 *
 * The round trip this guarantees is over the **dictionary**, not over the bytes: anything
 * {@link readVariantDictionary} produced, written and read again, is equal to itself. It is
 * deliberately not a byte-for-byte identity, because two tags can hold the same value and the
 * writer canonicalises to the narrowest correct one (below). In practice that distinction never
 * arises for a real file — KeePass writes Argon2's `I` and `M` as UInt64, `P` and `V` as
 * UInt32, `S` and `$UUID` as ByteArray, and every one of those survives unchanged.
 *
 * ### How a JavaScript value picks its tag
 *
 * The map is the source of truth and JavaScript has fewer number types than KDBX does, so the
 * choice is made by what the value *is* rather than by what tag it arrived under:
 *
 *  - `bigint` → **UInt64**, or **Int64** when negative. `bigint` is the type `types.ts` reserves
 *    for the 64-bit fields precisely because Argon2's memory cost is a byte count that a hostile
 *    file may set past `Number.MAX_SAFE_INTEGER`; anything that arrived as a `bigint` therefore
 *    goes back out 64 bits wide, never narrowed to fit.
 *  - `number` → **UInt32**, or **Int32** when negative. The reader only ever produces a `number`
 *    from a 32-bit field, so this is the exact inverse. Unsigned is preferred for a
 *    non-negative value because every 32-bit parameter KeePass actually writes — `P`, `V`, the
 *    AES-KDF flags — is unsigned, and writing `V=19` as an Int32 would be a gratuitous
 *    difference from every other tool's output.
 *  - `boolean` → **Bool**, `string` → **String**, `Uint8Array` → **ByteArray**. No ambiguity.
 *
 * A value that cannot be written losslessly — a fraction, a `NaN`, an integer outside its tag's
 * range — throws a plain `Error` rather than a `VaultError`, because it cannot be caused by a
 * file. Only this repo constructs a dictionary to write, so reaching one of those is a bug in
 * Keyhold and should read like one. Note what it is **not** allowed to do: silently wrap. A
 * `DataView` narrows a too-large `bigint` modulo 2^64 without complaint, and a KDF parameter
 * that quietly wrapped is the wrong-key-reported-as-wrong-password failure again.
 */
export function writeVariantDictionary(dictionary: VariantDictionary): Uint8Array {
  // Assembled as a list of chunks and allocated once, rather than appended into a growing
  // buffer. `ByteWriter` is the right shape for a structure whose length is not known until
  // the last field is written; a dictionary's length is known exactly from its own contents
  // before the first byte goes down, so the doubling and the copying buy nothing. It is still
  // used below for every fixed-width field, which is what it is exactly right for.
  const chunks: Uint8Array[] = [new ByteWriter().u16(VARIANT_DICTIONARY_VERSION).finish()];

  for (const [key, value] of dictionary) {
    // The reader refuses an empty name, so writing one would produce a file this very module
    // cannot read back. Guards on the two sides of a format have to agree.
    if (key === '') throw unwritable('an unnamed parameter', 'has no name');

    const keyBytes = ENCODER.encode(key);
    const encoded = encodeValue(key, value);

    chunks.push(new ByteWriter().u8(encoded.type).u32(keyBytes.length).finish());
    chunks.push(keyBytes);
    chunks.push(new ByteWriter().u32(encoded.bytes.length).finish());
    chunks.push(encoded.bytes);
  }

  chunks.push(Uint8Array.of(TYPE_END));
  return concat(chunks);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

interface EncodedValue {
  readonly type: number;
  readonly bytes: Uint8Array;
}

function encodeValue(key: string, value: VariantValue): EncodedValue {
  if (typeof value === 'boolean') {
    return { type: TYPE_BOOL, bytes: Uint8Array.of(value ? 1 : 0) };
  }

  if (typeof value === 'bigint') {
    if (value < 0n) {
      if (value < MIN_INT64) throw unwritable(key, 'is below the range of a 64-bit integer');
      return { type: TYPE_INT64, bytes: new ByteWriter().i64(value).finish() };
    }
    if (value > MAX_UINT64) throw unwritable(key, 'is above the range of a 64-bit integer');
    return { type: TYPE_UINT64, bytes: new ByteWriter().u64(value).finish() };
  }

  if (typeof value === 'number') {
    // Catches `NaN` and both infinities as well as fractions — all three of which a `DataView`
    // would otherwise write as some perfectly plausible integer.
    if (!Number.isInteger(value)) throw unwritable(key, 'is not a whole number');
    if (value < 0) {
      if (value < MIN_INT32) throw unwritable(key, 'is below the range of a 32-bit integer');
      return { type: TYPE_INT32, bytes: new ByteWriter().i32(value).finish() };
    }
    if (value > MAX_UINT32) throw unwritable(key, 'is above the range of a 32-bit integer');
    return { type: TYPE_UINT32, bytes: new ByteWriter().u32(value).finish() };
  }

  if (typeof value === 'string') {
    return { type: TYPE_STRING, bytes: ENCODER.encode(value) };
  }

  return { type: TYPE_BYTE_ARRAY, bytes: value };
}

/**
 * A programming error, worded as one — and, like every refusal here, without the value in it.
 *
 * The writer is the half of this module that handles the salt on the way out, so "never quote
 * a value" applies with more force here than it does on the read side, not less.
 */
function unwritable(key: string, why: string): Error {
  return new Error(`Cannot write the KDF parameter "${key}": its value ${why}.`);
}
