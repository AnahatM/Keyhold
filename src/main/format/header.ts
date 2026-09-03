// SPDX-License-Identifier: GPL-3.0-or-later
import {
  CIPHER_ID,
  FORMAT_VERSION,
  KDF_ID,
  type KeepHeader,
  type KdfParams,
  type SealedBox,
} from '@shared/format/types.js';
import { malformed } from '../crypto/errors.js';

/**
 * The KEEP header: serialisation, and — more importantly — validation of a header that
 * arrived from an untrusted file.
 *
 * The header is plaintext, because it has to be: it says which KDF parameters to use, so
 * it must be readable before any key exists. It is passed as AAD to the body's AEAD, so
 * modifying it breaks the body's authentication tag. That gives us integrity without
 * confidentiality, which is exactly the right trade for this data.
 *
 * **Everything here treats the header as hostile input.** A `.keep` file can be handed to
 * a user by anyone. The tag protects against *modification of a genuine vault*; it does
 * nothing about a file that was malicious from the start, and that file's header is
 * parsed before a single byte is authenticated. So: explicit type checks on every field,
 * no trusting `JSON.parse` to produce the declared shape.
 *
 * ## Nothing read out of the file is interpolated into a message
 *
 * This is the first thing in the app that reads an untrusted file, and its messages do not
 * stop here: `VaultError.message` reaches an error dialog, and `recovery/file-inspection.ts`
 * borrows it verbatim into the diagnostic report, which is written to be pasted somewhere
 * public. Two messages here used to interpolate a value straight out of the header —
 * `unsupported key-derivation algorithm "${alg}"` and `unsupported cipher "${cipher}"` — with
 * `sanitiseDetail`'s 200-character cap as the only thing standing behind them. A cap says
 * nothing about *what* those characters are: a quote, a newline, an ANSI escape, or 200
 * characters of anything at all, chosen by whoever wrote the file.
 *
 * The severity is lower here than in `history-detail.ts`, and worth stating so nobody
 * over-reads it: the header is plaintext by design and a crafted file's content is the
 * attacker's own, not the user's secret, so this is report pollution rather than a leak. But
 * it is the same shape, it fails the same way, and the fix is the same one — **every string
 * below is assembled from literals in this file plus values that are safe by construction.**
 * Where a reader genuinely needs to know which algorithm the file claimed, it is reported
 * from `KNOWN_KDF_IDS` / `KNOWN_CIPHER_IDS` — an allow-list of names this build compiled in.
 * A name that is not on the list is reported as unrecognised, never reproduced.
 *
 * **So do not reach for a sanitiser here.** Escaping a string built by interpolating untrusted
 * content has to win every time; the next adversarial name only has to be new once. That
 * exchange has already been lost once in this codebase — see the note at the foot of
 * `src/main/recovery/text.ts` for `redactUnknownFields`, and `history-detail.ts` for what
 * replaced it.
 */

/**
 * Key-derivation algorithm names this build is willing to repeat back.
 *
 * `KDF_ID` is the only one it can *use*. The rest are here because they are the plausible
 * things a real file might claim — an older Keyhold, a KDBX vault renamed to `.keep`, another
 * manager's export — and "the header claims argon2i" sends a user somewhere useful in a way
 * that "an unrecognised name" does not. Nothing on this list came out of a file; every entry is
 * compiled in, which is what makes repeating one safe.
 */
const KNOWN_KDF_IDS: readonly string[] = [
  KDF_ID,
  'argon2i',
  'argon2d',
  'pbkdf2',
  'scrypt',
  'bcrypt',
  'aes-kdf',
];

/** The same, for the body cipher. */
const KNOWN_CIPHER_IDS: readonly string[] = [
  CIPHER_ID,
  'AES-128-GCM',
  'AES-256-CBC',
  'ChaCha20-Poly1305',
  'XChaCha20-Poly1305',
  'Salsa20',
  'Twofish',
];

/**
 * How the message refers to an algorithm the file claimed.
 *
 * Returns the entry *from the allow-list*, not the caller's string. The two are equal whenever
 * a match is found, so it changes no output — it makes the allow-list structural rather than
 * remembered, and lets a reviewer see at a glance that the only algorithm names able to reach
 * an error dialog are ones this build compiled in.
 *
 * The unmatched case reports a length instead. Code points rather than UTF-16 units, because
 * the number is for a human: it distinguishes "the field is empty", "the field is a plausible
 * name I have not heard of", and "the field is four kilobytes of junk", which is the whole of
 * what the length was ever telling anyone.
 */
function claimedAlgorithm(claimed: string, known: readonly string[]): string {
  const match = known.find((name) => name === claimed);
  return match === undefined
    ? `a name this build does not recognise (${Array.from(claimed).length} character(s))`
    : `"${match}"`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string') throw malformed(`header field "${key}" is not a string`);
  return value;
}

function requireInteger(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw malformed(`header field "${key}" is not an integer`);
  }
  return value;
}

function requireNonNegativeInteger(source: Record<string, unknown>, key: string): number {
  const value = requireInteger(source, key);
  if (value < 0) throw malformed(`header field "${key}" is negative`);
  return value;
}

/** Rejects a value that is not valid base64, so a bad field fails here rather than as a mystery later. */
function requireBase64(source: Record<string, unknown>, key: string): string {
  const value = requireString(source, key);
  // Node's base64 decoder is lenient — it silently drops invalid characters — so the
  // round-trip comparison is what actually validates. Padding is normalised first.
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw malformed(`header field "${key}" is not valid base64`);
  }
  return value;
}

function parseSealedBox(value: unknown, label: string): SealedBox {
  if (!isPlainObject(value)) throw malformed(`header field "${label}" is not an object`);
  return {
    nonce: requireBase64(value, 'nonce'),
    ciphertext: requireBase64(value, 'ciphertext'),
    tag: requireBase64(value, 'tag'),
  };
}

function parseKdfParams(value: unknown): KdfParams {
  if (!isPlainObject(value)) throw malformed('header field "kdf" is not an object');

  const alg = requireString(value, 'alg');
  if (alg !== KDF_ID) {
    throw malformed(
      `unsupported key-derivation algorithm — the header claims ${claimedAlgorithm(alg, KNOWN_KDF_IDS)}, and this build derives keys with "${KDF_ID}" only`
    );
  }

  return {
    alg: KDF_ID,
    memoryKib: requireNonNegativeInteger(value, 'memoryKib'),
    iterations: requireNonNegativeInteger(value, 'iterations'),
    parallelism: requireNonNegativeInteger(value, 'parallelism'),
    salt: requireBase64(value, 'salt'),
  };
}

/**
 * Parses and validates a header from raw bytes.
 *
 * Note what this does NOT do: check the format version. Version gating happens earlier,
 * against the fixed-width field in the binary preamble, so an unreadable future header
 * never reaches a parser written for today's shape.
 */
export function parseHeader(bytes: Uint8Array): KeepHeader {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw malformed('the header is not valid JSON');
  }

  if (!isPlainObject(raw)) throw malformed('the header is not a JSON object');

  const cipher = requireString(raw, 'cipher');
  if (cipher !== CIPHER_ID) {
    throw malformed(
      `unsupported cipher — the header claims ${claimedAlgorithm(cipher, KNOWN_CIPHER_IDS)}, and this build reads "${CIPHER_ID}" only`
    );
  }

  return {
    formatVersion: requireNonNegativeInteger(raw, 'formatVersion'),
    vaultId: requireString(raw, 'vaultId'),
    deviceId: requireString(raw, 'deviceId'),
    kdf: parseKdfParams(raw.kdf),
    cipher: CIPHER_ID,
    wrappedDek: parseSealedBox(raw.wrappedDek, 'wrappedDek'),
    createdAt: requireNonNegativeInteger(raw, 'createdAt'),
    modifiedAt: requireNonNegativeInteger(raw, 'modifiedAt'),
    generation: requireNonNegativeInteger(raw, 'generation'),
    recordCount: requireNonNegativeInteger(raw, 'recordCount'),
    attachmentCount: requireNonNegativeInteger(raw, 'attachmentCount'),
  };
}

/**
 * Serialises a header to the exact bytes that will be written AND passed as AAD.
 *
 * **Key order is fixed and explicit**, not left to object-literal iteration order. The
 * AAD must be byte-identical on write and on read, so anything that could reorder keys —
 * a refactor, a spread, a different JSON implementation — would silently break every
 * existing vault's authentication. Writing the object out field by field makes that
 * ordering a deliberate, visible property rather than an accident that happens to hold.
 */
export function serialiseHeader(header: KeepHeader): Uint8Array {
  const ordered = {
    formatVersion: header.formatVersion,
    vaultId: header.vaultId,
    deviceId: header.deviceId,
    kdf: {
      alg: header.kdf.alg,
      memoryKib: header.kdf.memoryKib,
      iterations: header.kdf.iterations,
      parallelism: header.kdf.parallelism,
      salt: header.kdf.salt,
    },
    cipher: header.cipher,
    wrappedDek: {
      nonce: header.wrappedDek.nonce,
      ciphertext: header.wrappedDek.ciphertext,
      tag: header.wrappedDek.tag,
    },
    createdAt: header.createdAt,
    modifiedAt: header.modifiedAt,
    generation: header.generation,
    recordCount: header.recordCount,
    attachmentCount: header.attachmentCount,
  };

  return new Uint8Array(Buffer.from(JSON.stringify(ordered), 'utf8'));
}

/** A header for a brand-new vault. */
export function newHeader(input: {
  vaultId: string;
  deviceId: string;
  kdf: KdfParams;
  wrappedDek: SealedBox;
  now?: number;
}): KeepHeader {
  const now = input.now ?? Date.now();
  return {
    formatVersion: FORMAT_VERSION,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    kdf: input.kdf,
    cipher: CIPHER_ID,
    wrappedDek: input.wrappedDek,
    createdAt: now,
    modifiedAt: now,
    generation: 1,
    recordCount: 0,
    attachmentCount: 0,
  };
}
