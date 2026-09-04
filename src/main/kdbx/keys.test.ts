// SPDX-License-Identifier: GPL-3.0-or-later
import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { argon2id } from 'hash-wasm';
import { VaultError } from '../crypto/errors.js';
import { deriveCompositeKey, deriveKdbxKeys, readKdfParameters } from './keys.js';
import {
  KDF_AES,
  KDF_ARGON2D,
  KDF_ARGON2ID,
  MAX_AES_KDF_ROUNDS,
  MAX_KDF_ITERATIONS,
  MAX_KDF_MEMORY,
  type KdbxKdfParams,
  type VariantValue,
} from './types.js';

/**
 * KDBX key derivation is one of the places where a silent regression is genuinely expensive:
 * every wrong answer here looks exactly like "the user typed the wrong password", so nothing
 * in the UI would ever point at it.
 *
 * The known-answer tests below therefore restate the rule the long way — fresh `node:crypto`
 * calls, one hash at a time — rather than calling the implementation twice. The AES-KDF chain
 * is reproduced end to end because it needs nothing but Node; the Argon2 chain is reproduced
 * around a direct `hash-wasm` call, which is the same primitive but not the same code path.
 *
 * Argon2 is slow on purpose, so every parameter set here is deliberately feeble. Production
 * parameters come out of the file being imported, never from us.
 */

// Distinctive, greppable material. Test 6 asserts none of it reaches a refusal message.
const SALT = Buffer.from('salt-must-never-be-logged-000000', 'utf8');
const SEED = Buffer.from('seed-must-never-be-logged-000000', 'utf8');
const MASTER_SEED = Buffer.from('master-seed-32-bytes-long-000000', 'utf8');
const PASSWORD = 'correct horse battery staple';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** The composite key, written out the long way so the tests state the rule themselves. */
const compositeTheLongWay = (password: string): Buffer =>
  createHash('sha256')
    .update(createHash('sha256').update(Buffer.from(password, 'utf8')).digest())
    .digest();

const uuidOf = (id: string): Uint8Array => Uint8Array.from(Buffer.from(id, 'hex'));

/** A realistic Argon2 parameter map: KeePassXC's own defaults, 64 MiB and 10 passes. */
const argon2Dictionary = (id: string = KDF_ARGON2D): Map<string, VariantValue> =>
  new Map<string, VariantValue>([
    ['$UUID', uuidOf(id)],
    ['S', Uint8Array.from(SALT)],
    ['I', 10n],
    ['M', BigInt(64 * 1024 * 1024)],
    ['P', 4],
    ['V', 0x13],
  ]);

/** A realistic AES-KDF parameter map: KeePass 2's own default round count. */
const aesDictionary = (): Map<string, VariantValue> =>
  new Map<string, VariantValue>([
    ['$UUID', uuidOf(KDF_AES)],
    ['S', Uint8Array.from(SEED)],
    ['R', 60_000n],
  ]);

/** Asserts that `fn` refused, and hands back the refusal for further inspection. */
const refusalFrom = (fn: () => unknown): VaultError => {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected a refusal, but the call succeeded').toBeInstanceOf(VaultError);
  return caught as VaultError;
};

describe('readKdfParameters', () => {
  it('reads a realistic Argon2d parameter map', () => {
    const params = readKdfParameters(argon2Dictionary(KDF_ARGON2D));

    expect(params).toEqual<KdbxKdfParams>({
      kind: 'argon2',
      variant: 'd',
      salt: Uint8Array.from(SALT),
      iterations: 10,
      memoryKib: 65_536,
      parallelism: 4,
      version: 0x13,
    });
  });

  it('reads a realistic Argon2id parameter map', () => {
    const params = readKdfParameters(argon2Dictionary(KDF_ARGON2ID));
    expect(params.kind).toBe('argon2');
    expect(params).toMatchObject({ variant: 'id', memoryKib: 65_536 });
  });

  it('reads a realistic AES-KDF parameter map', () => {
    const params = readKdfParameters(aesDictionary());

    expect(params).toEqual<KdbxKdfParams>({
      kind: 'aes',
      seed: Uint8Array.from(SEED),
      rounds: 60_000,
    });
  });

  it('converts the memory cost from bytes to kibibytes rather than passing bytes through', () => {
    const dictionary = argon2Dictionary();
    dictionary.set('M', BigInt(19_456 * 1024));

    expect(readKdfParameters(dictionary)).toMatchObject({ memoryKib: 19_456 });
  });

  it('refuses an unknown $UUID by name', () => {
    const dictionary = argon2Dictionary();
    const unknown = 'ad68f29f576f4bb9a36ad47af965346c'; // Twofish-KDF-shaped: not implemented.
    dictionary.set('$UUID', uuidOf(unknown));

    const error = refusalFrom(() => readKdfParameters(dictionary));
    expect(error.code).toBe('MALFORMED');
    expect(error.message).toContain(unknown);
  });

  it('refuses a $UUID that is not 16 bytes', () => {
    const dictionary = argon2Dictionary();
    dictionary.set('$UUID', new Uint8Array(4));

    expect(refusalFrom(() => readKdfParameters(dictionary)).message).toContain('16');
  });

  it('refuses a missing salt by name', () => {
    const dictionary = argon2Dictionary();
    dictionary.delete('S');

    const error = refusalFrom(() => readKdfParameters(dictionary));
    expect(error.code).toBe('MALFORMED');
    expect(error.message).toContain('"S"');
  });

  it('refuses a wrong-typed iteration count by name', () => {
    const dictionary = argon2Dictionary();
    // A 32-bit `number` where the format specifies UInt64. Coercing it would mean guessing at
    // a parameter that decides the key.
    dictionary.set('I', 10);

    const error = refusalFrom(() => readKdfParameters(dictionary));
    expect(error.code).toBe('MALFORMED');
    expect(error.message).toContain('"I"');
    expect(error.message).toContain('64-bit');
  });

  it('refuses a memory cost above MAX_KDF_MEMORY as TOO_LARGE', () => {
    const dictionary = argon2Dictionary();
    dictionary.set('M', BigInt(MAX_KDF_MEMORY) + 1024n);

    expect(refusalFrom(() => readKdfParameters(dictionary)).code).toBe('TOO_LARGE');
  });

  it('refuses an absurd 64-bit memory cost without losing precision on the way', () => {
    const dictionary = argon2Dictionary();
    dictionary.set('M', 2n ** 63n);

    expect(refusalFrom(() => readKdfParameters(dictionary)).code).toBe('TOO_LARGE');
  });

  it('refuses an iteration count above MAX_KDF_ITERATIONS as TOO_LARGE', () => {
    const dictionary = argon2Dictionary();
    dictionary.set('I', BigInt(MAX_KDF_ITERATIONS) + 1n);

    expect(refusalFrom(() => readKdfParameters(dictionary)).code).toBe('TOO_LARGE');
  });

  it('refuses a memory cost that is not a whole number of kibibytes rather than rounding', () => {
    const dictionary = argon2Dictionary();
    dictionary.set('M', BigInt(64 * 1024 * 1024) + 1n);

    const error = refusalFrom(() => readKdfParameters(dictionary));
    expect(error.code).toBe('MALFORMED');
    expect(error.message).toContain('kibibytes');
  });

  it('refuses Argon2 version 1.0, which hash-wasm cannot compute', () => {
    const dictionary = argon2Dictionary();
    dictionary.set('V', 0x10);

    const error = refusalFrom(() => readKdfParameters(dictionary));
    expect(error.code).toBe('MALFORMED');
    expect(error.message).toContain('1.0');
  });

  it('refuses a salt below Argon2 own minimum', () => {
    const dictionary = argon2Dictionary();
    dictionary.set('S', new Uint8Array(4));

    expect(refusalFrom(() => readKdfParameters(dictionary)).code).toBe('MALFORMED');
  });

  it('refuses a memory cost too small for the declared lane count', () => {
    const dictionary = argon2Dictionary();
    dictionary.set('M', BigInt(8 * 1024)); // 8 KiB across 4 lanes: below Argon2 m >= 8p.

    expect(refusalFrom(() => readKdfParameters(dictionary)).code).toBe('MALFORMED');
  });

  it('refuses an AES-KDF seed that is not 32 bytes', () => {
    const dictionary = aesDictionary();
    dictionary.set('S', new Uint8Array(16));

    expect(refusalFrom(() => readKdfParameters(dictionary)).message).toContain('32');
  });

  it('refuses an AES-KDF round count above MAX_AES_KDF_ROUNDS as TOO_LARGE', () => {
    const dictionary = aesDictionary();
    dictionary.set('R', BigInt(MAX_AES_KDF_ROUNDS) + 1n);

    expect(refusalFrom(() => readKdfParameters(dictionary)).code).toBe('TOO_LARGE');
  });

  it('refuses a missing AES-KDF round count by name', () => {
    const dictionary = aesDictionary();
    dictionary.delete('R');

    expect(refusalFrom(() => readKdfParameters(dictionary)).message).toContain('"R"');
  });
});

describe('deriveCompositeKey', () => {
  it('is SHA-256 of SHA-256 of the UTF-8 password', () => {
    // Written out one hash at a time: the point of this test is to state KeePass's rule for a
    // password-only database, not to agree with whatever keys.ts happens to do.
    const inner = createHash('sha256').update(Buffer.from(PASSWORD, 'utf8')).digest();
    const expected = createHash('sha256').update(inner).digest();

    expect(hex(deriveCompositeKey(PASSWORD))).toBe(expected.toString('hex'));
  });

  it('is 32 bytes and hashes UTF-8, not UTF-16 or latin1', () => {
    const composite = deriveCompositeKey('pässwörd — ünicode');
    const expected = createHash('sha256')
      .update(createHash('sha256').update(Buffer.from('pässwörd — ünicode', 'utf8')).digest())
      .digest();

    expect(composite).toHaveLength(32);
    expect(hex(composite)).toBe(expected.toString('hex'));
  });

  it('separates two passwords that differ by one character', () => {
    expect(hex(deriveCompositeKey('password'))).not.toBe(hex(deriveCompositeKey('passwore')));
  });
});

describe('deriveKdbxKeys — AES-KDF, computed the long way', () => {
  // Three rounds, not KeePass's 60,000: the round count is not what is under test, and the
  // suite should stay fast.
  const AES_KDF: KdbxKdfParams = { kind: 'aes', seed: Uint8Array.from(SEED), rounds: 3 };

  /** The whole chain restated with fresh Node primitives, a fresh cipher per round. */
  const expectedKeys = (
    password: string,
    masterSeed: Buffer,
    rounds: number
  ): { cipher: string; hmac: string; transformed: Buffer } => {
    let block: Buffer = compositeTheLongWay(password);
    for (let round = 0; round < rounds; round += 1) {
      const cipher = createCipheriv('aes-256-ecb', SEED, null);
      cipher.setAutoPadding(false);
      block = Buffer.concat([cipher.update(block), cipher.final()]);
    }
    const transformed = createHash('sha256').update(block).digest();

    return {
      transformed,
      cipher: createHash('sha256').update(masterSeed).update(transformed).digest('hex'),
      hmac: createHash('sha512')
        .update(masterSeed)
        .update(transformed)
        .update(Buffer.from([0x01]))
        .digest('hex'),
    };
  };

  it('produces exactly SHA-256(seed||transformed) and SHA-512(seed||transformed||0x01)', async () => {
    const expected = expectedKeys(PASSWORD, MASTER_SEED, 3);
    const keys = await deriveKdbxKeys(deriveCompositeKey(PASSWORD), MASTER_SEED, AES_KDF);

    expect(keys.secretCipherKey.use(hex)).toBe(expected.cipher);
    expect(keys.secretHmacKey.use(hex)).toBe(expected.hmac);
    keys.destroy();
  });

  it('does not derive the HMAC key without the trailing 0x01', async () => {
    // The negative half of the pin above. Drop the domain separator and the HMAC base becomes
    // SHA-512 of precisely the string SHA-256 turns into the cipher key — two keys, one input.
    const { transformed } = expectedKeys(PASSWORD, MASTER_SEED, 3);
    const withoutSuffix = createHash('sha512')
      .update(MASTER_SEED)
      .update(transformed)
      .digest('hex');

    const keys = await deriveKdbxKeys(deriveCompositeKey(PASSWORD), MASTER_SEED, AES_KDF);
    expect(keys.secretHmacKey.use(hex)).not.toBe(withoutSuffix);
    keys.destroy();
  });

  it('reuses one cipher across rounds without changing the answer', async () => {
    // keys.ts keeps a single ECB cipher for every round; this pins that optimisation against a
    // fresh-cipher-per-round reference at a round count where a chaining bug would show.
    const expected = expectedKeys(PASSWORD, MASTER_SEED, 17);
    const keys = await deriveKdbxKeys(deriveCompositeKey(PASSWORD), MASTER_SEED, {
      kind: 'aes',
      seed: Uint8Array.from(SEED),
      rounds: 17,
    });

    expect(keys.secretCipherKey.use(hex)).toBe(expected.cipher);
    keys.destroy();
  });

  it('changes the keys when the round count changes', async () => {
    const three = await deriveKdbxKeys(deriveCompositeKey(PASSWORD), MASTER_SEED, AES_KDF);
    const four = await deriveKdbxKeys(deriveCompositeKey(PASSWORD), MASTER_SEED, {
      kind: 'aes',
      seed: Uint8Array.from(SEED),
      rounds: 4,
    });

    expect(three.secretCipherKey.use(hex)).not.toBe(four.secretCipherKey.use(hex));
    three.destroy();
    four.destroy();
  });
});

describe('deriveKdbxKeys — Argon2', () => {
  /** Feeble on purpose. Production parameters come from the file, not from us. */
  const ARGON2ID: KdbxKdfParams = {
    kind: 'argon2',
    variant: 'id',
    salt: Uint8Array.from(SALT),
    iterations: 1,
    memoryKib: 32,
    parallelism: 1,
    version: 0x13,
  };

  it('produces exactly SHA-256(seed||argon2) and SHA-512(seed||argon2||0x01)', async () => {
    // Argon2 itself is called directly here, so this pins the framing around it — the two
    // digests, their order, and the 0x01 — rather than re-running keys.ts.
    const transformed = Buffer.from(
      await argon2id({
        password: compositeTheLongWay(PASSWORD),
        salt: SALT,
        parallelism: 1,
        iterations: 1,
        memorySize: 32,
        hashLength: 32,
        outputType: 'binary',
      })
    );
    const expectedCipher = createHash('sha256').update(MASTER_SEED).update(transformed).digest();
    const expectedHmac = createHash('sha512')
      .update(MASTER_SEED)
      .update(transformed)
      .update(Buffer.from([0x01]))
      .digest();

    const keys = await deriveKdbxKeys(deriveCompositeKey(PASSWORD), MASTER_SEED, ARGON2ID);
    expect(keys.secretCipherKey.use(hex)).toBe(expectedCipher.toString('hex'));
    expect(keys.secretHmacKey.use(hex)).toBe(expectedHmac.toString('hex'));
    keys.destroy();
  });

  it('is deterministic and produces a 32-byte cipher key and a 64-byte HMAC key', async () => {
    const first = await deriveKdbxKeys(deriveCompositeKey(PASSWORD), MASTER_SEED, ARGON2ID);
    const second = await deriveKdbxKeys(deriveCompositeKey(PASSWORD), MASTER_SEED, ARGON2ID);

    expect(first.secretCipherKey.length).toBe(32);
    expect(first.secretHmacKey.length).toBe(64);
    expect(first.secretCipherKey.use(hex)).toBe(second.secretCipherKey.use(hex));
    expect(first.secretHmacKey.use(hex)).toBe(second.secretHmacKey.use(hex));

    first.destroy();
    second.destroy();
  });

  it('changes both keys when one bit of the master seed changes', async () => {
    const flipped = Buffer.from(MASTER_SEED);
    flipped[0] = (flipped[0] ?? 0) ^ 0b0000_0001;

    const original = await deriveKdbxKeys(deriveCompositeKey(PASSWORD), MASTER_SEED, ARGON2ID);
    const changed = await deriveKdbxKeys(deriveCompositeKey(PASSWORD), flipped, ARGON2ID);

    expect(changed.secretCipherKey.use(hex)).not.toBe(original.secretCipherKey.use(hex));
    expect(changed.secretHmacKey.use(hex)).not.toBe(original.secretHmacKey.use(hex));

    original.destroy();
    changed.destroy();
  });

  it('derives different keys for Argon2d and Argon2id', async () => {
    const d = await deriveKdbxKeys(deriveCompositeKey(PASSWORD), MASTER_SEED, {
      ...ARGON2ID,
      kind: 'argon2',
      variant: 'd',
    });
    const id = await deriveKdbxKeys(deriveCompositeKey(PASSWORD), MASTER_SEED, ARGON2ID);

    expect(d.secretCipherKey.use(hex)).not.toBe(id.secretCipherKey.use(hex));
    d.destroy();
    id.destroy();
  });

  it('refuses a master seed that is not 32 bytes', async () => {
    await expect(
      deriveKdbxKeys(deriveCompositeKey(PASSWORD), new Uint8Array(16), ARGON2ID)
    ).rejects.toThrow(VaultError);
  });

  it('refuses a composite key that is not 32 bytes', async () => {
    await expect(deriveKdbxKeys(new Uint8Array(16), MASTER_SEED, ARGON2ID)).rejects.toThrow(
      VaultError
    );
  });

  it('leaves both keys destroyed after destroy(), idempotently', async () => {
    const keys = await deriveKdbxKeys(deriveCompositeKey(PASSWORD), MASTER_SEED, ARGON2ID);
    keys.destroy();
    keys.destroy();

    expect(keys.secretCipherKey.destroyed).toBe(true);
    expect(keys.secretHmacKey.destroyed).toBe(true);
    expect(() => keys.secretCipherKey.use(hex)).toThrow();
  });
});

describe('refusals never carry secret material', () => {
  it('names no salt, seed or password in any refusal message', () => {
    const bad: (() => unknown)[] = [
      () => {
        const d = argon2Dictionary();
        d.set('$UUID', uuidOf('00000000000000000000000000000000'));
        return readKdfParameters(d);
      },
      () => {
        const d = argon2Dictionary();
        d.delete('S');
        return readKdfParameters(d);
      },
      () => {
        const d = argon2Dictionary();
        d.set('I', 'ten');
        return readKdfParameters(d);
      },
      () => {
        const d = argon2Dictionary();
        d.set('M', BigInt(MAX_KDF_MEMORY) * 4n);
        return readKdfParameters(d);
      },
      () => {
        const d = argon2Dictionary();
        d.set('M', BigInt(64 * 1024 * 1024) + 512n);
        return readKdfParameters(d);
      },
      () => {
        const d = argon2Dictionary();
        d.set('V', 0x10);
        return readKdfParameters(d);
      },
      () => {
        const d = aesDictionary();
        d.set('R', BigInt(MAX_AES_KDF_ROUNDS) * 2n);
        return readKdfParameters(d);
      },
      () => {
        const d = aesDictionary();
        d.set('S', new Uint8Array(8));
        return readKdfParameters(d);
      },
    ];

    // Every encoding the material could plausibly leak through: raw, hex, base64.
    const forbidden = [SALT, SEED, Buffer.from(PASSWORD, 'utf8')].flatMap((material) => [
      material.toString('utf8'),
      material.toString('hex'),
      material.toString('base64'),
    ]);

    for (const attempt of bad) {
      const { message } = refusalFrom(attempt);
      for (const secret of forbidden) {
        expect(message, `refusal leaked material: ${message}`).not.toContain(secret);
      }
    }
  });

  it('says nothing about the composite key when the KDF itself rejects the parameters', async () => {
    // Parameters that passed `readKdfParameters` cannot reach hash-wasm broken, so this fakes
    // the disagreement directly. What matters is that the third party's sentence — written
    // about arguments that include the composite key — is dropped rather than forwarded.
    const impossible: KdbxKdfParams = {
      kind: 'argon2',
      variant: 'id',
      salt: Uint8Array.from(SALT),
      iterations: 0,
      memoryKib: 32,
      parallelism: 1,
      version: 0x13,
    };

    await expect(
      deriveKdbxKeys(deriveCompositeKey(PASSWORD), MASTER_SEED, impossible)
    ).rejects.toThrow(/rejected by the key-derivation function/);
  });
});
