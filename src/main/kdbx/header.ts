// SPDX-License-Identifier: GPL-3.0-or-later
import { ByteReader, ByteWriter } from './binary.js';
// `keys.ts` owns the KDF vocabulary and every bound on a KDF parameter; this file owns the
// framing. Re-stating the parameter names here would be the second list rule 8 forbids.
import { readKdfParameters as readKdfFrom } from './keys.js';
import { readVariantDictionary, writeVariantDictionary } from './variant-dictionary.js';
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
  MAX_HEADER_FIELD,
  OUTER_HEADER_CIPHER_ID,
  OUTER_HEADER_COMMENT,
  OUTER_HEADER_COMPRESSION,
  OUTER_HEADER_ENCRYPTION_IV,
  OUTER_HEADER_END,
  OUTER_HEADER_KDF_PARAMETERS,
  OUTER_HEADER_MASTER_SEED,
  OUTER_HEADER_PUBLIC_CUSTOM_DATA,
  badKdbx,
  kdbxTooLarge,
  uuidHex,
  type KdbxBinary,
  type KdbxCipher,
  type KdbxInnerHeader,
  type KdbxOuterHeader,
  type VariantValue,
} from './types.js';

/**
 * The two headers of a KDBX 4 file, read and written.
 *
 * A KDBX file has a **plaintext outer header** — signature, version, cipher, seeds, KDF
 * parameters — followed by its own SHA-256 and its own HMAC, and then an encrypted payload
 * whose first bytes are an **inner header** carrying the value-protection key and the
 * attachments. The two are separate because the outer one has to be readable before any key
 * exists, and the inner one must not be.
 *
 * ## The plaintext header is authenticated, and that is the interesting part
 *
 * The same arrangement as Keyhold's own KEEP container, arrived at independently: reading the
 * header without the password is intended, and modifying it must break authentication.
 * KeePass does it with two hashes rather than with AEAD associated data — a SHA-256 of the
 * header, which catches corruption, and an HMAC keyed from the master key, which catches
 * somebody who downgraded the KDF parameters to make the database cheap to attack. **The
 * HMAC is the one that matters**, and it can only be checked after the KDF has run, so the
 * order below is: parse, hash-check, derive, HMAC-check, decrypt. A reader that skipped the
 * HMAC would open the file perfectly well and would have no way to notice the tampering it
 * exists to catch.
 *
 * ## Every length here comes from an untrusted file
 *
 * Each field is `id, uint32 length, bytes`, and the length is whatever the file says. It is
 * bounded before it is used, every time. KDBX 3 used a `uint16` for that length, which is one
 * of several reasons a version-3 file is refused rather than leniently attempted.
 */

/** `\r\n\r\n`, which KeePass writes as the end-marker field's payload. Content is ignored. */
const END_MARKER = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);

function readField(reader: ByteReader, what: string): { id: number; data: Uint8Array } {
  const id = reader.u8(`${what} field id`);
  const size = reader.u32(`${what} field length`);
  if (size > MAX_HEADER_FIELD) {
    throw kdbxTooLarge(`${what} field of ${String(size)} bytes`);
  }
  return { id, data: reader.bytes(size, `a ${what} field`) };
}

function writeField(writer: ByteWriter, id: number, data: Uint8Array): void {
  writer.u8(id).u32(data.length).bytes(data);
}

/**
 * Reads the outer header, leaving the reader positioned at its SHA-256.
 *
 * Returns the header's own bytes alongside the parsed values, because both hashes are taken
 * over the exact bytes on disk rather than over a re-serialisation of them. Re-serialising to
 * hash is the classic way to make a signature check meaningless: two byte sequences that parse
 * to the same values then verify identically, and the attacker picks whichever one the rest of
 * the program treats differently.
 */
export function readOuterHeader(reader: ByteReader): KdbxOuterHeader {
  const signature1 = reader.u32('the file signature');
  const signature2 = reader.u32('the file signature');

  if (signature1 !== KDBX_SIGNATURE_1) {
    throw badKdbx('it does not start with a KeePass signature');
  }
  if (signature2 !== KDBX_SIGNATURE_2) {
    // 0xB54BFB65 is KeePass 1's `.kdb`, which is a different format rather than an older
    // version of this one. Named, because "not a KeePass file" would be a lie to somebody
    // holding a KeePass file.
    throw badKdbx(
      signature2 === 0xb5_4b_fb_65
        ? 'it is a KeePass 1 `.kdb` file, which is a different format — open it in KeePass and save it as a `.kdbx`'
        : 'it is not a KeePass 2 database'
    );
  }

  const version = reader.u32('the format version');
  const major = version >>> 16;

  if (major === 3) {
    // Refused by name, and this is a decision rather than an omission — D32. A version-3
    // database protects its in-XML values with Salsa20, which Node does not provide, and
    // writing a stream cipher by hand is what "never invent cryptography" forbids.
    throw badKdbx(
      'it is a KDBX 3 database. Keyhold reads KDBX 4. Open it in KeePassXC and use Database → Save as, which writes KDBX 4 by default'
    );
  }
  if (major !== KDBX_MAJOR_VERSION) {
    throw badKdbx(`it is KDBX version ${String(major)}, and Keyhold reads version 4`);
  }

  let cipher: KdbxCipher | null = null;
  let compressed: boolean | null = null;
  let masterSeed: Uint8Array | null = null;
  let encryptionIv: Uint8Array | null = null;
  let kdfDictionary: ReadonlyMap<string, VariantValue> | null = null;
  let publicCustomData: Uint8Array | null = null;

  for (;;) {
    const field = readField(reader, 'a header');
    if (field.id === OUTER_HEADER_END) break;

    switch (field.id) {
      case OUTER_HEADER_COMMENT:
        // Written by nothing current, ignored by everything. Read and discarded rather than
        // refused: it is a legal field, and refusing a legal field a tool might write is how
        // an importer earns a reputation for not opening files that work elsewhere.
        break;
      case OUTER_HEADER_CIPHER_ID: {
        if (field.data.length !== 16) throw badKdbx('its cipher id is not 16 bytes');
        const id = uuidHex(field.data);
        if (id === CIPHER_TWOFISH) {
          throw badKdbx(
            'it uses the Twofish cipher, which Keyhold does not implement. Re-save it in KeePassXC with AES-256 or ChaCha20'
          );
        }
        if (id !== CIPHER_AES256_CBC && id !== CIPHER_CHACHA20) {
          throw badKdbx('it uses a cipher Keyhold does not recognise');
        }
        cipher = id;
        break;
      }
      case OUTER_HEADER_COMPRESSION: {
        if (field.data.length !== 4) throw badKdbx('its compression flag is not 4 bytes');
        const flag = new ByteReader(field.data).u32('the compression flag');
        if (flag !== 0 && flag !== 1) throw badKdbx('it declares an unknown compression method');
        compressed = flag === 1;
        break;
      }
      case OUTER_HEADER_MASTER_SEED:
        if (field.data.length !== 32) throw badKdbx('its master seed is not 32 bytes');
        masterSeed = field.data;
        break;
      case OUTER_HEADER_ENCRYPTION_IV:
        encryptionIv = field.data;
        break;
      case OUTER_HEADER_KDF_PARAMETERS:
        kdfDictionary = readVariantDictionary(field.data);
        break;
      case OUTER_HEADER_PUBLIC_CUSTOM_DATA:
        publicCustomData = field.data;
        break;
      default:
        // An unknown *outer* field is refused, unlike the comment above, and the asymmetry is
        // deliberate: fields 5, 6, 8, 9 and 10 are KDBX 3's transform seed, rounds, stream key
        // and stream id. A file carrying one is a version-3 file wearing a 4 in its header,
        // and reading it as a 4 would derive the wrong key and blame the password.
        throw badKdbx(
          `it carries header field ${String(field.id)}, which does not belong in a KDBX 4 file`
        );
    }
  }

  if (cipher === null) throw badKdbx('it does not say which cipher it used');
  if (compressed === null) throw badKdbx('it does not say whether it is compressed');
  if (masterSeed === null) throw badKdbx('it has no master seed');
  if (encryptionIv === null) throw badKdbx('it has no encryption IV');
  if (kdfDictionary === null) throw badKdbx('it has no key-derivation parameters');

  const expectedIv = cipher === CIPHER_CHACHA20 ? 12 : 16;
  if (encryptionIv.length !== expectedIv) {
    throw badKdbx(
      `its encryption IV is ${String(encryptionIv.length)} bytes, and this cipher needs ${String(expectedIv)}`
    );
  }

  return {
    cipher,
    compressed,
    masterSeed,
    encryptionIv,
    // Parsed by `keys.ts`, which owns every bound on a KDF parameter. Kept as the dictionary
    // here so this file has exactly one job and the ceilings live in exactly one place.
    kdf: readKdfFrom(kdfDictionary),
    publicCustomData,
    raw: reader.consumed(),
  };
}

export interface OuterHeaderInput {
  readonly cipher: KdbxCipher;
  readonly compressed: boolean;
  readonly masterSeed: Uint8Array;
  readonly encryptionIv: Uint8Array;
  readonly kdfParameters: ReadonlyMap<string, VariantValue>;
}

/** Serialises an outer header, signature first, end marker last. */
export function writeOuterHeader(input: OuterHeaderInput): Uint8Array {
  const writer = new ByteWriter();
  writer.u32(KDBX_SIGNATURE_1);
  writer.u32(KDBX_SIGNATURE_2);
  writer.u32((KDBX_MAJOR_VERSION << 16) | KDBX_MINOR_VERSION);

  writeField(writer, OUTER_HEADER_CIPHER_ID, Buffer.from(input.cipher, 'hex'));

  const compression = new ByteWriter().u32(input.compressed ? 1 : 0).finish();
  writeField(writer, OUTER_HEADER_COMPRESSION, compression);

  writeField(writer, OUTER_HEADER_MASTER_SEED, input.masterSeed);
  writeField(writer, OUTER_HEADER_ENCRYPTION_IV, input.encryptionIv);
  writeField(writer, OUTER_HEADER_KDF_PARAMETERS, writeVariantDictionary(input.kdfParameters));
  writeField(writer, OUTER_HEADER_END, END_MARKER);

  return writer.finish();
}

// ── The inner header ─────────────────────────────────────────────────────────

/**
 * Reads the inner header from the front of the decrypted stream.
 *
 * Returns the header and the offset the XML starts at, rather than the XML itself, so the
 * caller decides whether to copy the payload — it can be tens of megabytes, and a database
 * that size does not need two of them in memory at once.
 */
export function readInnerHeader(payload: Uint8Array): {
  readonly header: KdbxInnerHeader;
  readonly xmlOffset: number;
} {
  const reader = new ByteReader(payload);
  let streamId: number | null = null;
  let streamKey: Uint8Array | null = null;
  const binaries: KdbxBinary[] = [];

  for (;;) {
    const field = readField(reader, 'an inner header');
    if (field.id === INNER_HEADER_END) break;

    switch (field.id) {
      case INNER_HEADER_STREAM_ID:
        if (field.data.length !== 4) throw badKdbx('its inner stream id is not 4 bytes');
        streamId = new ByteReader(field.data).u32('the inner stream id');
        break;
      case INNER_HEADER_STREAM_KEY:
        streamKey = field.data;
        break;
      case INNER_HEADER_BINARY: {
        // One flags byte, then the attachment. An empty field is not a zero-length attachment
        // — it is a truncated one, and reading it as empty would silently lose a file.
        if (field.data.length < 1) throw badKdbx('it has an attachment with no flags byte');
        binaries.push({ flags: field.data[0] ?? 0, data: field.data.subarray(1) });
        break;
      }
      default:
        throw badKdbx(`it carries inner header field ${String(field.id)}, which is not defined`);
    }
  }

  if (streamId === null) throw badKdbx('it does not say how its values are protected');
  if (streamKey === null) throw badKdbx('it has no value-protection key');

  return { header: { streamId, streamKey, binaries }, xmlOffset: reader.offset };
}

export interface InnerHeaderInput {
  readonly streamId: number;
  readonly streamKey: Uint8Array;
  readonly binaries: readonly KdbxBinary[];
}

export function writeInnerHeader(input: InnerHeaderInput): Uint8Array {
  const writer = new ByteWriter();
  writeField(writer, INNER_HEADER_STREAM_ID, new ByteWriter().u32(input.streamId).finish());
  writeField(writer, INNER_HEADER_STREAM_KEY, input.streamKey);

  for (const binary of input.binaries) {
    writeField(
      writer,
      INNER_HEADER_BINARY,
      new ByteWriter().u8(binary.flags).bytes(binary.data).finish()
    );
  }

  writeField(writer, INNER_HEADER_END, new Uint8Array(0));
  return writer.finish();
}
