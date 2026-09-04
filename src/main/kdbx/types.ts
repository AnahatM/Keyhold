// SPDX-License-Identifier: GPL-3.0-or-later
import { VaultError } from '../crypto/errors.js';

/**
 * The shared vocabulary of the KDBX reader and writer.
 *
 * KDBX is KeePass's own database format, and Keyhold reads and writes **version 4 only**.
 * This file holds the constants, types and errors the rest of `src/main/kdbx/` agrees about,
 * so that no two modules have to independently decide what a cipher id or a KDF parameter is
 * called. It contains no logic beyond the two helpers at the bottom.
 *
 * ## Why this format is implemented rather than imported (D32)
 *
 * `kdbxweb` is a good library and was the plan. Against it: every primitive KDBX 4 needs is
 * already in this repo — Argon2 over `hash-wasm`, AES-256-CBC, ChaCha20 and HMAC-SHA256 in
 * Node's own crypto, gzip in `node:zlib`, and the inner XML in `import/xml-reader.ts` — so the
 * dependency would have bought the schema mapping, which is the part that has to be written
 * and tested here whichever way it went. A third-party parser in the path of an untrusted file
 * is exactly what this project spends its dependency budget avoiding.
 *
 * **This is composition, not invention.** Every primitive here ships in Node or in `hash-wasm`.
 * Nothing in this folder implements a cipher, a hash or a KDF; it implements KeePass's framing
 * around them, which is a file format rather than cryptography.
 *
 * ## KDBX 3 is decided against, not deferred
 *
 * A version-3 database protects its in-XML values with **Salsa20**, which Node does not
 * provide. Hand-writing a stream cipher is precisely what "never invent cryptography" forbids,
 * so a `.kdbx` that is version 3 is refused **by name**, with the advice to re-save it from
 * KeePassXC as KDBX 4 — which that application does by default.
 */

// ── File identity ────────────────────────────────────────────────────────────

/** `0x9AA2D903`. The first four bytes of every KDBX file, whatever the version. */
export const KDBX_SIGNATURE_1 = 0x9a_a2_d9_03;

/** `0xB54BFB67`. KeePass 2 / KDBX. (KeePass 1's `.kdb` is `0xB54BFB65` and is not read.) */
export const KDBX_SIGNATURE_2 = 0xb5_4b_fb_67;

/** The only major version read or written. See the header for why 3 is refused. */
export const KDBX_MAJOR_VERSION = 4;

/** Written as 4.0. KeePassXC reads 4.0 and 4.1; 4.1 adds fields this writer does not use. */
export const KDBX_MINOR_VERSION = 0;

// ── Outer header field ids ───────────────────────────────────────────────────

export const OUTER_HEADER_END = 0;
export const OUTER_HEADER_COMMENT = 1;
export const OUTER_HEADER_CIPHER_ID = 2;
export const OUTER_HEADER_COMPRESSION = 3;
export const OUTER_HEADER_MASTER_SEED = 4;
export const OUTER_HEADER_ENCRYPTION_IV = 7;
export const OUTER_HEADER_KDF_PARAMETERS = 11;
export const OUTER_HEADER_PUBLIC_CUSTOM_DATA = 12;

// ── Inner header field ids (KDBX 4 only; inside the decrypted stream) ─────────

export const INNER_HEADER_END = 0;
export const INNER_HEADER_STREAM_ID = 1;
export const INNER_HEADER_STREAM_KEY = 2;
export const INNER_HEADER_BINARY = 3;

// ── Ciphers ──────────────────────────────────────────────────────────────────

/** `31C1F2E6-BF71-4350-BE58-05216AFC5AFF` — AES-256-CBC with PKCS#7. The default. */
export const CIPHER_AES256_CBC = '31c1f2e6bf714350be5805216afc5aff';

/** `D6038A2B-8B6F-4CB5-A524-339A31DBB59A` — ChaCha20, 12-byte nonce, counter 0. */
export const CIPHER_CHACHA20 = 'd6038a2b8b6f4cb5a524339a31dbb59a';

/** `AD68F29F-576F-4BB9-A36A-D47AF965346C` — Twofish. Not implemented; refused by name. */
export const CIPHER_TWOFISH = 'ad68f29f576f4bb9a36ad47af965346c';

export type KdbxCipher = typeof CIPHER_AES256_CBC | typeof CIPHER_CHACHA20;

// ── KDFs ─────────────────────────────────────────────────────────────────────

/** `EF636DDF-8C29-444B-91F7-A9A403E30A0C` — Argon2d. KeePass's default for KDBX 4. */
export const KDF_ARGON2D = 'ef636ddf8c29444b91f7a9a403e30a0c';

/** `9E298B19-56DB-4773-B23D-FE5F0F6D3C8D` — Argon2id. */
export const KDF_ARGON2ID = '9e298b1956db4773b23dfe5f0f6d3c8d';

/** `C9D9F39A-628A-4460-BF74-0D08C18A4FEA` — AES-KDF, KDBX 3's transform, legal in 4. */
export const KDF_AES = 'c9d9f39a628a4460bf740d08c18a4fea';

// ── Inner random stream ──────────────────────────────────────────────────────

/**
 * The block index the **header's** HMAC uses: `0xFFFFFFFFFFFFFFFF`.
 *
 * A `bigint` because it does not fit a `number`, and a named constant because it appears in
 * two files — the reader and the writer — and a header authenticated at one index and
 * verified at another fails in a way that looks exactly like a wrong password.
 */
export const HEADER_HMAC_INDEX = 2n ** 64n - 1n;

/** Salsa20. Refused by name — Node does not provide it, and we do not write ciphers. */
export const INNER_STREAM_SALSA20 = 2;

/** ChaCha20, keyed by SHA-512 of the inner key. The only one KDBX 4 writes. */
export const INNER_STREAM_CHACHA20 = 3;

// ── Safety ceilings ──────────────────────────────────────────────────────────
//
// Every one of these bounds a number read straight out of an untrusted file. The format
// permits far larger, and a file claiming a 4 GB header field is not a database — it is an
// allocation bomb, and the only correct response is to refuse it before allocating.

/** A KDBX header is a few hundred bytes. 10 MB is absurd and still cheap to refuse. */
export const MAX_HEADER_FIELD = 10 * 1024 * 1024;

/** The decrypted, decompressed payload. A 200,000-entry database is far under this. */
export const MAX_PAYLOAD = 512 * 1024 * 1024;

/** One HMAC block, as KeePass writes them. The format's own maximum is 1 MB. */
export const MAX_BLOCK = 16 * 1024 * 1024;

/** Argon2 memory, in bytes. Above this a file could exhaust the machine on unlock. */
export const MAX_KDF_MEMORY = 2 * 1024 * 1024 * 1024;

/** Argon2 iterations. Above this an unlock never finishes, which is a denial of service. */
export const MAX_KDF_ITERATIONS = 1_000;

/** AES-KDF rounds. KeePass's own default is ~60,000; this is generous and bounded. */
export const MAX_AES_KDF_ROUNDS = 100_000_000;

// ── Parsed shapes ────────────────────────────────────────────────────────────

/**
 * A KeePass `VariantDictionary`, as a plain map.
 *
 * Values are kept in the widest JavaScript type that holds them losslessly: `bigint` for the
 * 64-bit integers, because Argon2's memory parameter is a byte count that genuinely exceeds
 * `Number.MAX_SAFE_INTEGER`'s comfort zone when a file is hostile, and silently truncating it
 * is how a bounds check gets bypassed.
 */
export type VariantValue = boolean | number | bigint | string | Uint8Array;

export type VariantDictionary = ReadonlyMap<string, VariantValue>;

/** The KDF the file asks for, already validated against the ceilings above. */
export type KdbxKdfParams =
  | {
      readonly kind: 'argon2';
      /** `argon2d` is KeePass's default; `argon2id` is also written by some tools. */
      readonly variant: 'd' | 'id';
      readonly salt: Uint8Array;
      readonly iterations: number;
      /** Kibibytes, as `hash-wasm` wants it — the file states bytes, and this is /1024. */
      readonly memoryKib: number;
      readonly parallelism: number;
      /** Argon2 version: 0x13 (19) is current; 0x10 (16) is the old one. */
      readonly version: number;
    }
  | {
      readonly kind: 'aes';
      readonly seed: Uint8Array;
      readonly rounds: number;
    };

/** Everything the outer header carries, plus its own bytes for the AAD-like HMAC. */
export interface KdbxOuterHeader {
  readonly cipher: KdbxCipher;
  readonly compressed: boolean;
  readonly masterSeed: Uint8Array;
  readonly encryptionIv: Uint8Array;
  readonly kdf: KdbxKdfParams;
  readonly publicCustomData: Uint8Array | null;
  /** The header exactly as it appeared on disk, from the signature to the end marker. */
  readonly raw: Uint8Array;
}

/** An attachment carried in the inner header, referenced from the XML by index. */
export interface KdbxBinary {
  /** KeePass's flags byte. Bit 0 means "protected in memory"; it does not affect the bytes. */
  readonly flags: number;
  readonly data: Uint8Array;
}

/** The inner header, which in KDBX 4 sits at the front of the decrypted stream. */
export interface KdbxInnerHeader {
  readonly streamId: number;
  readonly streamKey: Uint8Array;
  readonly binaries: readonly KdbxBinary[];
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * A refusal about somebody else's file, worded for the person who chose it.
 *
 * Not `crypto/errors.ts`'s `malformed`, whose message begins "This vault file is damaged" —
 * true of a `.keep`, and alarming nonsense about a KeePass database that KeePass opens fine.
 * The code is the same so callers need not branch; only the sentence differs. The same reason
 * `import/xml-reader.ts` has its own.
 */
export function badKdbx(detail: string): VaultError {
  return new VaultError('MALFORMED', `This KeePass database could not be read: ${detail}.`);
}

/**
 * A refusal about a size a file declared.
 *
 * Separate from `badKdbx` because the code differs and callers act on it: `TOO_LARGE` is the
 * app saying "this claims to be enormous", which is a different conversation from "this is
 * damaged" — and the ceilings above exist precisely so that claim is refused before anything
 * is allocated on the strength of it.
 */
export function kdbxTooLarge(detail: string): VaultError {
  return new VaultError('TOO_LARGE', `This KeePass database declares ${detail}.`);
}

/** Formats a 16-byte UUID as lower-case hex, which is how the constants above are written. */
export function uuidHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
