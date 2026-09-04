// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter } from './binary.js';
import { readInnerHeader, readOuterHeader, writeOuterHeader } from './header.js';
import {
  CIPHER_AES256_CBC,
  CIPHER_CHACHA20,
  CIPHER_TWOFISH,
  INNER_HEADER_BINARY,
  INNER_HEADER_END,
  INNER_HEADER_STREAM_ID,
  INNER_HEADER_STREAM_KEY,
  KDBX_MAJOR_VERSION,
  KDBX_MINOR_VERSION,
  KDBX_SIGNATURE_1,
  KDBX_SIGNATURE_2,
  KDF_ARGON2ID,
  OUTER_HEADER_CIPHER_ID,
  OUTER_HEADER_COMMENT,
  OUTER_HEADER_COMPRESSION,
  OUTER_HEADER_ENCRYPTION_IV,
  OUTER_HEADER_END,
  OUTER_HEADER_KDF_PARAMETERS,
  OUTER_HEADER_MASTER_SEED,
  type VariantValue,
} from './types.js';
import { writeVariantDictionary } from './variant-dictionary.js';

/**
 * The KDBX header, refused directly rather than through a round trip.
 *
 * The round trip in `kdbx.test.ts` is the right test for "does a file Keyhold writes come back
 * as what went in". It is the **wrong** test for the refusals, and the ledger said so: a
 * refusal that stopped firing would be noticed there only if it also broke a read, and most of
 * these would not. A header that quietly accepted a 4-byte master seed, or an undefined inner
 * field, would round-trip perfectly against itself and fail against every other KeePass client
 * — or worse, against a real database somebody was trying to import.
 *
 * ## What a refusal has to do here
 *
 * This module parses a file **the user was handed by another program**, before any of it is
 * authenticated. Two things follow, and both are asserted:
 *
 *  1. **It refuses rather than guesses.** Every declared length is checked against the length
 *     the format requires, and a field the format does not define is a refusal rather than a
 *     skip — an unrecognised *outer* field means this is not a file this reader understands.
 *  2. **It says what the file is**, when it can. "Not a KeePass 2 database" is a lie to
 *     somebody holding a KeePass 1 `.kdb`, and "unsupported" is useless to somebody holding a
 *     KDBX 3 whose only problem is that it needs re-saving. Both are named, with the action.
 *
 * ## Fault injection performed, three defects
 *
 *  1. The 32-byte master-seed length check removed — failed `refuses a master seed that is not
 *     32 bytes`, which is the one that would have round-tripped happily against itself.
 *  2. The KDBX 3 branch removed, leaving the generic version message — failed `names KDBX 3
 *     and says what to do about it`.
 *  3. The undefined-inner-field refusal turned into a `break` — failed `refuses an inner
 *     header field the format does not define`.
 */

const AES_IV = new Uint8Array(16).fill(7);
const SEED = new Uint8Array(32).fill(9);

/**
 * A KDF block the reader will accept.
 *
 * `VariantValue` is the raw value, not a tagged one — the dictionary writer picks the type code
 * from the JavaScript type. `$UUID` must be a KDF this reader supports: the header validates it
 * on the way past, so an invented UUID is refused before any of the assertions below are
 * reached. Writing that down because the first draft used `0x03…` and every "good header" case
 * failed on a KDF error, several layers away from what it was testing.
 */
function kdfParameters(): ReadonlyMap<string, VariantValue> {
  return new Map<string, VariantValue>([
    ['$UUID', Buffer.from(KDF_ARGON2ID, 'hex')],
    ['S', new Uint8Array(32).fill(5)],
    ['I', 2n],
    ['M', 19_456n * 1024n],
    ['P', 1],
    ['V', 0x13],
  ]);
}

/** A header that reads cleanly, as the baseline every refusal below is one change away from. */
function goodHeader(): Uint8Array {
  return writeOuterHeader({
    cipher: CIPHER_AES256_CBC,
    compressed: true,
    masterSeed: SEED,
    encryptionIv: AES_IV,
    kdfParameters: kdfParameters(),
  });
}

function field(writer: ByteWriter, id: number, data: Uint8Array): ByteWriter {
  return writer.u8(id).u32(data.length).bytes(data);
}

/** An outer header built field by field, so one of them can be made wrong. */
function outerHeader(
  fields: readonly { readonly id: number; readonly data: Uint8Array }[],
  version = (KDBX_MAJOR_VERSION << 16) | KDBX_MINOR_VERSION
): Uint8Array {
  const writer = new ByteWriter().u32(KDBX_SIGNATURE_1).u32(KDBX_SIGNATURE_2).u32(version);
  for (const entry of fields) field(writer, entry.id, entry.data);
  field(writer, OUTER_HEADER_END, new Uint8Array([13, 10, 13, 10]));
  return writer.finish();
}

const COMPLETE = [
  { id: OUTER_HEADER_CIPHER_ID, data: Buffer.from(CIPHER_AES256_CBC, 'hex') },
  { id: OUTER_HEADER_COMPRESSION, data: new ByteWriter().u32(1).finish() },
  { id: OUTER_HEADER_MASTER_SEED, data: SEED },
  { id: OUTER_HEADER_ENCRYPTION_IV, data: AES_IV },
  { id: OUTER_HEADER_KDF_PARAMETERS, data: writeVariantDictionary(kdfParameters()) },
];

/** Every field but one, so the "it does not say X" refusals can be reached. */
const without = (id: number): typeof COMPLETE => COMPLETE.filter((entry) => entry.id !== id);

const read = (bytes: Uint8Array): ReturnType<typeof readOuterHeader> =>
  readOuterHeader(new ByteReader(bytes));

describe('the outer header, read', () => {
  it('round-trips what the writer produced', () => {
    const header = read(goodHeader());

    expect(header.cipher).toBe(CIPHER_AES256_CBC);
    expect(header.compressed).toBe(true);
    expect([...header.masterSeed]).toEqual([...SEED]);
  });

  it('accepts a comment field rather than refusing a legal one', () => {
    // Written by nothing current and legal in the format. Refusing a legal field a tool might
    // write is how an importer earns a reputation for not opening files that work elsewhere.
    const bytes = outerHeader([
      { id: OUTER_HEADER_COMMENT, data: new TextEncoder().encode('written by something') },
      ...COMPLETE,
    ]);
    expect(() => read(bytes)).not.toThrow();
  });
});

describe('what it refuses, and what it says', () => {
  it('refuses a file that is not KeePass at all', () => {
    const bytes = new ByteWriter().u32(0x00_00_00_00).u32(0).u32(0).finish();
    expect(() => read(bytes)).toThrow(/KeePass signature/);
  });

  it('names a KeePass 1 `.kdb` rather than calling it "not a KeePass file"', () => {
    // It *is* a KeePass file. Saying otherwise to somebody holding one sends them looking for
    // a problem that is not there.
    const bytes = new ByteWriter().u32(KDBX_SIGNATURE_1).u32(0xb5_4b_fb_65).u32(0).finish();
    expect(() => read(bytes)).toThrow(/KeePass 1/);
  });

  it('names KDBX 3 and says what to do about it', () => {
    // The decision D32 recorded, not an omission: KDBX 3 protects its in-XML values with
    // Salsa20, which Node does not provide, and writing a stream cipher by hand is what
    // "never invent cryptography" forbids. "Unsupported" would be useless; the fix is one
    // Save As away and the message says so.
    const bytes = outerHeader(COMPLETE, (3 << 16) | 1);
    expect(() => read(bytes)).toThrow(/KDBX 3/);
    expect(() => read(bytes)).toThrow(/Save as/);
  });

  it('names the version when it is neither 3 nor 4', () => {
    expect(() => read(outerHeader(COMPLETE, 5 << 16))).toThrow(/version 5/);
  });

  it('refuses Twofish by name, and any other cipher generically', () => {
    const twofish = outerHeader([
      { id: OUTER_HEADER_CIPHER_ID, data: Buffer.from(CIPHER_TWOFISH, 'hex') },
      ...without(OUTER_HEADER_CIPHER_ID),
    ]);
    expect(() => read(twofish)).toThrow(/Twofish/);

    const invented = outerHeader([
      { id: OUTER_HEADER_CIPHER_ID, data: new Uint8Array(16).fill(0xab) },
      ...without(OUTER_HEADER_CIPHER_ID),
    ]);
    expect(() => read(invented)).toThrow(/does not recognise/);
  });

  it('accepts ChaCha20, with the 12-byte IV that cipher requires', () => {
    const bytes = outerHeader([
      { id: OUTER_HEADER_CIPHER_ID, data: Buffer.from(CIPHER_CHACHA20, 'hex') },
      { id: OUTER_HEADER_ENCRYPTION_IV, data: new Uint8Array(12).fill(7) },
      ...COMPLETE.filter(
        (entry) => entry.id !== OUTER_HEADER_CIPHER_ID && entry.id !== OUTER_HEADER_ENCRYPTION_IV
      ),
    ]);
    expect(read(bytes).cipher).toBe(CIPHER_CHACHA20);
  });

  it('refuses an IV of the wrong length for the cipher that was declared', () => {
    // 16 is right for AES-CBC and wrong for ChaCha20. A reader that took whichever length it
    // was given would derive a nonce from padding, which is the quietest possible way to
    // produce wrong plaintext.
    const bytes = outerHeader([
      { id: OUTER_HEADER_CIPHER_ID, data: Buffer.from(CIPHER_CHACHA20, 'hex') },
      ...without(OUTER_HEADER_CIPHER_ID),
    ]);
    expect(() => read(bytes)).toThrow(/needs 12/);
  });

  it('refuses a cipher id that is not 16 bytes', () => {
    const bytes = outerHeader([
      { id: OUTER_HEADER_CIPHER_ID, data: new Uint8Array(8) },
      ...without(OUTER_HEADER_CIPHER_ID),
    ]);
    expect(() => read(bytes)).toThrow(/16 bytes/);
  });

  it('refuses a master seed that is not 32 bytes', () => {
    // The one that would round-trip perfectly against itself: a writer and a reader that both
    // used four bytes would agree, and no KeePass client would.
    const bytes = outerHeader([
      { id: OUTER_HEADER_MASTER_SEED, data: new Uint8Array(4) },
      ...without(OUTER_HEADER_MASTER_SEED),
    ]);
    expect(() => read(bytes)).toThrow(/master seed/);
  });

  it('refuses a compression flag that is not 4 bytes, and an unknown method', () => {
    const short = outerHeader([
      { id: OUTER_HEADER_COMPRESSION, data: new Uint8Array(1) },
      ...without(OUTER_HEADER_COMPRESSION),
    ]);
    expect(() => read(short)).toThrow(/4 bytes/);

    const unknown = outerHeader([
      { id: OUTER_HEADER_COMPRESSION, data: new ByteWriter().u32(9).finish() },
      ...without(OUTER_HEADER_COMPRESSION),
    ]);
    expect(() => read(unknown)).toThrow(/compression method/);
  });

  it('names each field that is missing, rather than failing generically later', () => {
    // A generic "malformed header" would leave somebody with a real database and no idea
    // which half of it their other tool wrote differently.
    for (const [id, pattern] of [
      [OUTER_HEADER_CIPHER_ID, /which cipher/],
      [OUTER_HEADER_COMPRESSION, /whether it is compressed/],
      [OUTER_HEADER_MASTER_SEED, /no master seed/],
      [OUTER_HEADER_ENCRYPTION_IV, /no encryption IV/],
      [OUTER_HEADER_KDF_PARAMETERS, /key-derivation/],
    ] as const) {
      expect(() => read(outerHeader(without(id))), `missing field ${String(id)}`).toThrow(pattern);
    }
  });

  it('refuses an outer field the format does not define', () => {
    // Asymmetric with the inner header's comment allowance, deliberately: an unrecognised
    // outer field means this is not a file this reader understands, and guessing past it is
    // how a reader ends up decrypting with parameters it did not read.
    const bytes = outerHeader([{ id: 99, data: new Uint8Array(2) }, ...COMPLETE]);
    expect(() => read(bytes)).toThrow();
  });
});

describe('the inner header', () => {
  const innerHeader = (
    fields: readonly { readonly id: number; readonly data: Uint8Array }[]
  ): Uint8Array => {
    const writer = new ByteWriter();
    for (const entry of fields) field(writer, entry.id, entry.data);
    field(writer, INNER_HEADER_END, new Uint8Array(0));
    return writer.bytes(new TextEncoder().encode('<KeePassFile/>')).finish();
  };

  const COMPLETE_INNER = [
    { id: INNER_HEADER_STREAM_ID, data: new ByteWriter().u32(3).finish() },
    { id: INNER_HEADER_STREAM_KEY, data: new Uint8Array(64).fill(1) },
  ];

  it('reports where the XML starts rather than copying the payload', () => {
    // A database can be tens of megabytes; returning an offset rather than a slice keeps one
    // copy of it in memory instead of two.
    const payload = innerHeader(COMPLETE_INNER);
    const { header, xmlOffset } = readInnerHeader(payload);

    expect(header.streamId).toBe(3);
    expect(xmlOffset).toBeGreaterThan(0);
    expect(xmlOffset).toBeLessThan(payload.length);
  });

  it('refuses an inner stream id that is not 4 bytes', () => {
    const payload = innerHeader([
      { id: INNER_HEADER_STREAM_ID, data: new Uint8Array(2) },
      { id: INNER_HEADER_STREAM_KEY, data: new Uint8Array(64) },
    ]);
    expect(() => readInnerHeader(payload)).toThrow(/4 bytes/);
  });

  it('refuses an attachment with no flags byte', () => {
    const payload = innerHeader([
      ...COMPLETE_INNER,
      { id: INNER_HEADER_BINARY, data: new Uint8Array(0) },
    ]);
    expect(() => readInnerHeader(payload)).toThrow(/flags byte/);
  });

  it('refuses an inner header field the format does not define', () => {
    const payload = innerHeader([...COMPLETE_INNER, { id: 42, data: new Uint8Array(1) }]);
    expect(() => readInnerHeader(payload)).toThrow(/not defined/);
  });

  it('names the two things it cannot proceed without', () => {
    expect(() =>
      readInnerHeader(innerHeader([{ id: INNER_HEADER_STREAM_KEY, data: new Uint8Array(64) }]))
    ).toThrow(/how its values are protected/);

    expect(() =>
      readInnerHeader(
        innerHeader([{ id: INNER_HEADER_STREAM_ID, data: new ByteWriter().u32(3).finish() }])
      )
    ).toThrow(/value-protection key/);
  });
});
