// SPDX-License-Identifier: GPL-3.0-or-later
import { createCipheriv, createHash } from 'node:crypto';
import { argon2d, argon2id } from 'hash-wasm';
import { SecretBytes } from '../crypto/secret.js';
import {
  KDF_AES,
  KDF_ARGON2D,
  KDF_ARGON2ID,
  MAX_AES_KDF_ROUNDS,
  MAX_KDF_ITERATIONS,
  MAX_KDF_MEMORY,
  badKdbx,
  kdbxTooLarge,
  uuidHex,
  type KdbxKdfParams,
  type VariantDictionary,
  type VariantValue,
} from './types.js';

/**
 * KDBX 4 key derivation — from a master password to the two keys the file is protected with.
 *
 * A KDBX 4 database is opened with two keys, and both come from the same chain:
 *
 * ```
 *   composite   = SHA-256( SHA-256(utf8(password)) )         the credentials, hashed together
 *   transformed = KDF(composite)                             32 bytes, Argon2 or AES-KDF
 *   cipherKey   = SHA-256(masterSeed || transformed)         decrypts the payload
 *   hmacKey     = SHA-512(masterSeed || transformed || 0x01) the base of the block HMACs
 * ```
 *
 * **The trailing `0x01` is load-bearing, not decoration.** Without it the HMAC base would be
 * SHA-512 of exactly the input that SHA-256 turns into the cipher key, so the two keys would be
 * two hashes of one string — a domain-separation failure, and the kind of thing that is
 * invisible until it is not. KeePass then derives a per-block HMAC key as
 * `SHA-512(blockIndex_le64 || hmacBase)`, with `0xFFFFFFFFFFFFFFFF` for the header block; that
 * layer belongs to the reader, not here. This file stops at the base key.
 *
 * ## What is composed, and what is not invented
 *
 * SHA-256, SHA-512 and AES-256-ECB come from Node; Argon2 comes from `hash-wasm`, the same
 * implementation `crypto/kdf.ts` already uses for Keyhold's own vaults (decision D14). Nothing
 * here implements a hash, a cipher or a KDF — it implements KeePass's arrangement of them,
 * which is a file format. See the header of `types.ts` for why the format is read rather than
 * imported (D32).
 *
 * ## Credentials: password only
 *
 * KeePass's composite key is `SHA-256( concat of each credential's SHA-256 )`, over up to three
 * credentials in a fixed order: password, key file, then Windows user account. With a password
 * as the only credential that collapses to `SHA-256(SHA-256(password))`, which is what
 * `deriveCompositeKey` computes and all this module supports.
 *
 * **Key files and Windows-account credentials are deliberately not implemented.** A key file is
 * a second factor that lives outside the database, and Keyhold has nowhere to put it during an
 * import and no story for what happens to it afterwards; the Windows-account credential is
 * DPAPI-bound and cannot leave the machine that made it at all. Supporting either is a product
 * decision with a UI attached, so it belongs in the decision log before it belongs in code. A
 * database that needs one simply will not open, and the reader should say so by name rather
 * than reporting a wrong password.
 *
 * ## Argon2 version
 *
 * `hash-wasm@4` hardcodes Argon2 version `0x13` and exposes no way to ask for `0x10`. A file
 * that asks for the older version is therefore **refused by name** rather than derived at
 * `0x13`: a key derived under the wrong version is simply a different key, and presenting that
 * as "wrong password" would send the user off to retype a password that was right all along.
 */

// ── VariantDictionary keys, as KeePass spells them ───────────────────────────

const PARAM_UUID = '$UUID';
const PARAM_SALT = 'S';
const PARAM_ITERATIONS = 'I';
const PARAM_MEMORY = 'M';
const PARAM_PARALLELISM = 'P';
const PARAM_VERSION = 'V';
const PARAM_ROUNDS = 'R';

// ── Sizes and bounds ─────────────────────────────────────────────────────────

const UUID_BYTES = 16;

/** SHA-256 output, which is what every KDF here consumes and produces. */
const TRANSFORMED_KEY_BYTES = 32;

/** Outer header field 4. KDBX 4 fixes it at 32 bytes; a different length is not the format. */
const MASTER_SEED_BYTES = 32;

/** AES-KDF's transform seed is an AES-256 key, so it is exactly a key's worth of bytes. */
const AES_KDF_SEED_BYTES = 32;

/** Argon2's own minimum salt, from RFC 9106 — not a Keyhold policy number. */
const MIN_ARGON2_SALT_BYTES = 8;

/** Argon2's own maximum lane count (2^24 − 1). The cost is bounded by memory, above. */
const MAX_ARGON2_PARALLELISM = 0xff_ff_ff;

/** Argon2 1.3, the current version and the only one `hash-wasm` can produce. */
const ARGON2_VERSION_13 = 0x13;

/** Argon2 1.0. Written by KeePass 2.35-era builds; refused, see the header. */
const ARGON2_VERSION_10 = 0x10;

/** The domain separator that keeps the HMAC base from being a rehash of the cipher key input. */
const HMAC_KEY_SUFFIX = Uint8Array.of(0x01);

const BYTES_PER_KIB = 1024;

// ── Reading the parameter dictionary ─────────────────────────────────────────
//
// Every value below arrives from a file somebody else wrote, so each is fetched by name,
// type-checked, and range-checked before it is believed. The refusals name the *parameter*
// and never its value — except for sizes and identifiers, which are public header metadata.
// A salt or a seed never appears in a message (hard rule 1).

function requireValue(dictionary: VariantDictionary, name: string, what: string): VariantValue {
  const value = dictionary.get(name);
  if (value === undefined) {
    throw badKdbx(`its key-derivation settings are missing "${name}" (${what})`);
  }
  return value;
}

function requireByteArray(dictionary: VariantDictionary, name: string, what: string): Uint8Array {
  const value = requireValue(dictionary, name, what);
  if (!(value instanceof Uint8Array)) {
    throw badKdbx(`its key-derivation parameter "${name}" (${what}) is not a byte array`);
  }
  return value;
}

/**
 * A 64-bit parameter, which the dictionary reader hands over as a `bigint`.
 *
 * Strict about the type on purpose: a value that arrived as a `number` came out of a 32-bit
 * field, so the file has the wrong variant type there. Coercing it would mean guessing at a
 * parameter that decides the key, and a wrong guess reports "wrong password" for a correct one.
 */
function requireUInt64(dictionary: VariantDictionary, name: string, what: string): bigint {
  const value = requireValue(dictionary, name, what);
  if (typeof value !== 'bigint') {
    throw badKdbx(`its key-derivation parameter "${name}" (${what}) is not a 64-bit integer`);
  }
  if (value < 1n) {
    throw badKdbx(`its key-derivation parameter "${name}" (${what}) is not a positive number`);
  }
  return value;
}

function requireUInt32(dictionary: VariantDictionary, name: string, what: string): number {
  const value = requireValue(dictionary, name, what);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw badKdbx(`its key-derivation parameter "${name}" (${what}) is not a 32-bit integer`);
  }
  return value;
}

function readArgon2Parameters(dictionary: VariantDictionary, variant: 'd' | 'id'): KdbxKdfParams {
  const salt = requireByteArray(dictionary, PARAM_SALT, 'the Argon2 salt');
  if (salt.length < MIN_ARGON2_SALT_BYTES) {
    throw badKdbx(
      `its Argon2 salt is ${salt.length} bytes, below the ${MIN_ARGON2_SALT_BYTES}-byte minimum`
    );
  }

  const iterations = requireUInt64(dictionary, PARAM_ITERATIONS, 'the Argon2 iteration count');
  if (iterations > BigInt(MAX_KDF_ITERATIONS)) {
    throw kdbxTooLarge(
      `${String(iterations)} Argon2 iterations, above the limit of ${MAX_KDF_ITERATIONS}`
    );
  }

  // The ceiling is checked before the divisibility, because "this file wants 64 GiB" is the
  // allocation bomb and deserves the TOO_LARGE code even when the number is also misaligned.
  const memoryBytes = requireUInt64(dictionary, PARAM_MEMORY, 'the Argon2 memory cost');
  if (memoryBytes > BigInt(MAX_KDF_MEMORY)) {
    throw kdbxTooLarge(
      `an Argon2 memory cost of ${String(memoryBytes)} bytes, above the ${MAX_KDF_MEMORY}-byte limit`
    );
  }

  // KeePass states memory in bytes and Argon2 takes kibibytes. A value that is not a whole
  // number of KiB is refused rather than rounded: rounding it derives a *different key* and
  // then reports "wrong password" for a password that was correct, which is the worst possible
  // way for this to fail.
  if (memoryBytes % BigInt(BYTES_PER_KIB) !== 0n) {
    throw badKdbx(
      `its Argon2 memory cost of ${String(memoryBytes)} bytes is not a whole number of kibibytes`
    );
  }
  const memoryKib = Number(memoryBytes / BigInt(BYTES_PER_KIB));

  const parallelism = requireUInt32(dictionary, PARAM_PARALLELISM, 'the Argon2 parallelism');
  if (parallelism < 1 || parallelism > MAX_ARGON2_PARALLELISM) {
    throw badKdbx(`its Argon2 parallelism of ${parallelism} is outside the permitted range`);
  }

  // Argon2 requires m ≥ 8p; below that `hash-wasm` throws a message of its own making, and a
  // third-party exception is not a sentence to show a user.
  if (memoryKib < 8 * parallelism) {
    throw badKdbx(
      `its Argon2 memory cost of ${memoryKib} KiB is too small for ${parallelism} lanes`
    );
  }

  const version = requireUInt32(dictionary, PARAM_VERSION, 'the Argon2 version');
  if (version === ARGON2_VERSION_10) {
    throw badKdbx(
      'it uses Argon2 version 1.0, which this build cannot compute — re-save it from KeePassXC, ' +
        'which writes version 1.3'
    );
  }
  if (version !== ARGON2_VERSION_13) {
    throw badKdbx(`it declares an unrecognised Argon2 version (${version})`);
  }

  return {
    kind: 'argon2',
    variant,
    salt,
    iterations: Number(iterations),
    memoryKib,
    parallelism,
    version,
  };
}

function readAesKdfParameters(dictionary: VariantDictionary): KdbxKdfParams {
  const seed = requireByteArray(dictionary, PARAM_SALT, 'the AES-KDF transform seed');
  if (seed.length !== AES_KDF_SEED_BYTES) {
    throw badKdbx(`its AES-KDF transform seed is ${seed.length} bytes, not ${AES_KDF_SEED_BYTES}`);
  }

  const rounds = requireUInt64(dictionary, PARAM_ROUNDS, 'the AES-KDF round count');
  if (rounds > BigInt(MAX_AES_KDF_ROUNDS)) {
    throw kdbxTooLarge(
      `${String(rounds)} AES-KDF rounds, above the limit of ${MAX_AES_KDF_ROUNDS}`
    );
  }

  return { kind: 'aes', seed, rounds: Number(rounds) };
}

/**
 * Reads and validates the KDF parameters out of the outer header's `VariantDictionary`.
 *
 * Everything is checked before anything is returned, so a `KdbxKdfParams` in hand is a promise
 * that the numbers inside it are safe to hand to a KDF — that is the whole reason this returns
 * a narrowed type rather than the dictionary.
 */
export function readKdfParameters(dictionary: VariantDictionary): KdbxKdfParams {
  const uuid = requireByteArray(dictionary, PARAM_UUID, 'the key-derivation function id');
  if (uuid.length !== UUID_BYTES) {
    throw badKdbx(`its key-derivation function id is ${uuid.length} bytes, not ${UUID_BYTES}`);
  }

  const id = uuidHex(uuid);
  switch (id) {
    case KDF_ARGON2D:
      return readArgon2Parameters(dictionary, 'd');
    case KDF_ARGON2ID:
      return readArgon2Parameters(dictionary, 'id');
    case KDF_AES:
      return readAesKdfParameters(dictionary);
    default:
      // Named, not shrugged at: Twofish-era builds and any future KDF land here, and the id
      // is public header metadata that makes the refusal searchable.
      throw badKdbx(`it uses an unsupported key-derivation function (${id})`);
  }
}

// ── The composite key ────────────────────────────────────────────────────────

/**
 * KeePass's composite key for a password-only database.
 *
 * The general rule is `SHA-256( SHA-256(password) || SHA-256(keyFile) || SHA-256(account) )`,
 * over whichever credentials are present, in that order. With a password alone the
 * concatenation is one 32-byte hash, so the composite key is `SHA-256(SHA-256(password))` —
 * the double hash is the general rule collapsing, not an extra round for its own sake. See the
 * file header for why the other two credentials are out of scope.
 *
 * The returned bytes are key material. They are a plain `Uint8Array` rather than a
 * `SecretBytes` because the only caller feeds them straight to `deriveKdbxKeys`, which is where
 * the lifetime is short and visible; that caller is expected to zero them afterwards.
 *
 * The password `string` itself cannot be zeroed — V8 owns it, and it lives until it is
 * collected. That is the same limitation `crypto/kdf.ts` has and the threat model already
 * states: memory is not defended while the app is unlocked.
 */
export function deriveCompositeKey(secretPassword: string): Uint8Array {
  const secretPasswordBytes = Buffer.from(secretPassword, 'utf8');
  const secretInnerHash = createHash('sha256').update(secretPasswordBytes).digest();
  secretPasswordBytes.fill(0);

  const secretComposite = createHash('sha256').update(secretInnerHash).digest();
  secretInnerHash.fill(0);

  const result = Uint8Array.from(secretComposite);
  secretComposite.fill(0);
  return result;
}

// ── The KDF transform ────────────────────────────────────────────────────────

/**
 * Argon2 over the composite key.
 *
 * The parameters come out of the file, not out of Keyhold: an imported database was created by
 * KeePass with whatever cost its owner chose, and re-deriving under our own defaults would
 * produce a different key. That is also why this is genuinely slow on a real database and must
 * never run on a thread anything is waiting to paint (see CLAUDE.md).
 */
async function transformArgon2(
  secretCompositeKey: Uint8Array,
  kdf: Extract<KdbxKdfParams, { kind: 'argon2' }>
): Promise<Uint8Array> {
  const options = {
    password: secretCompositeKey,
    salt: kdf.salt,
    parallelism: kdf.parallelism,
    iterations: kdf.iterations,
    memorySize: kdf.memoryKib,
    hashLength: TRANSFORMED_KEY_BYTES,
    outputType: 'binary',
  } as const;

  try {
    return kdf.variant === 'd' ? await argon2d(options) : await argon2id(options);
  } catch {
    // The original message is dropped rather than wrapped. It is a third party's sentence
    // written about arguments that include the composite key, and hard rule 1 does not have an
    // exception for text somebody else composed. The parameters were validated on the way in,
    // so reaching here means the file disagrees with `hash-wasm` about what is computable.
    throw badKdbx('its Argon2 settings were rejected by the key-derivation function');
  }
}

/**
 * AES-KDF: KDBX 3's transform, still legal in a version 4 file.
 *
 * `rounds` iterations of AES-256-ECB over the 32-byte composite key — both halves, in place,
 * keyed by the transform seed — then SHA-256 of the result. ECB is correct here and only here:
 * this is not encrypting a message, it is iterating a permutation to burn time, and the block
 * count is fixed at two. Padding is off because the input is already block-aligned and a
 * PKCS#7 tail would change the value.
 *
 * One cipher instance serves every round because ECB carries no chaining state, which turns
 * KeePass's default 60,000 rounds from 60,000 allocations into one.
 */
function transformAesKdf(
  secretCompositeKey: Uint8Array,
  kdf: Extract<KdbxKdfParams, { kind: 'aes' }>
): Uint8Array {
  const cipher = createCipheriv('aes-256-ecb', kdf.seed, null);
  cipher.setAutoPadding(false);

  let secretBlock = Buffer.from(secretCompositeKey);
  try {
    for (let round = 0; round < kdf.rounds; round += 1) {
      const next = cipher.update(secretBlock);
      secretBlock.fill(0);
      secretBlock = next;
    }
    // Block-aligned input with padding off, so this yields nothing. It is called anyway
    // because leaving a cipher unfinalised leaks its OpenSSL context.
    cipher.final();

    const secretTransformed = createHash('sha256').update(secretBlock).digest();
    const result = Uint8Array.from(secretTransformed);
    secretTransformed.fill(0);
    return result;
  } finally {
    secretBlock.fill(0);
  }
}

// ── The two file keys ────────────────────────────────────────────────────────

export interface KdbxKeys {
  /** The payload cipher key: SHA-256(masterSeed || transformedKey). */
  readonly secretCipherKey: SecretBytes;
  /** The block-HMAC base key: SHA-512(masterSeed || transformedKey || 0x01). */
  readonly secretHmacKey: SecretBytes;
  destroy(): void;
}

/**
 * Derives the payload key and the HMAC base key for one KDBX 4 database.
 *
 * `secretCompositeKey` stays the caller's to zero — it is theirs, and taking ownership of a
 * buffer the caller may still be holding is how a double-zero or a use-after-free starts.
 * Everything this function allocates in between is zeroed before it returns, on the error path
 * as well as the happy one.
 */
export async function deriveKdbxKeys(
  secretCompositeKey: Uint8Array,
  masterSeed: Uint8Array,
  kdf: KdbxKdfParams
): Promise<KdbxKeys> {
  if (masterSeed.length !== MASTER_SEED_BYTES) {
    throw badKdbx(`its master seed is ${masterSeed.length} bytes, not ${MASTER_SEED_BYTES}`);
  }
  if (secretCompositeKey.length !== TRANSFORMED_KEY_BYTES) {
    // Not a statement about the file — a composite key is always a SHA-256 output, so a
    // different length is a caller bug, caught here rather than mis-keying AES-KDF silently.
    throw badKdbx(
      `its composite key is ${secretCompositeKey.length} bytes, not ${TRANSFORMED_KEY_BYTES}`
    );
  }

  const secretTransformedKey =
    kdf.kind === 'argon2'
      ? await transformArgon2(secretCompositeKey, kdf)
      : transformAesKdf(secretCompositeKey, kdf);

  try {
    // Copied out of the digest buffers rather than adopted: a `Buffer` can be a view into a
    // shared pool, and zeroing a pooled slice later would either miss the key or scribble on
    // somebody else's bytes — the same reasoning as `ByteReader.bytes` in `binary.ts`.
    const secretCipherDigest = createHash('sha256')
      .update(masterSeed)
      .update(secretTransformedKey)
      .digest();
    const secretCipherKey = SecretBytes.copyOf(secretCipherDigest);
    secretCipherDigest.fill(0);

    const secretHmacDigest = createHash('sha512')
      .update(masterSeed)
      .update(secretTransformedKey)
      .update(HMAC_KEY_SUFFIX)
      .digest();
    const secretHmacKey = SecretBytes.copyOf(secretHmacDigest);
    secretHmacDigest.fill(0);

    return {
      secretCipherKey,
      secretHmacKey,
      destroy(): void {
        secretCipherKey.destroy();
        secretHmacKey.destroy();
      },
    };
  } finally {
    secretTransformedKey.fill(0);
  }
}
