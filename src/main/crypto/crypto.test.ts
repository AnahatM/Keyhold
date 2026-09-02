// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KDF_PARAMS,
  KDF_ID,
  KEY_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
} from '@shared/format/types.js';
import { decrypt, encrypt, fromSealedBox, toSealedBox } from './aead.js';
import { VaultError } from './errors.js';
import {
  createVaultKeys,
  generateDek,
  rewrapForNewPassword,
  unlock,
  unwrapDek,
  wrapDek,
} from './envelope.js';
import { assertUsableKdfParams, calibrateKdf, deriveKey, newKdfParams } from './kdf.js';
import { randomBytes, randomInt, shuffleInPlace } from './random.js';
import { SecretBytes } from './secret.js';

/**
 * The security-critical tests. A silent regression in any of this is invisible in the UI
 * and catastrophic in effect — a vault that still opens fine while being trivially
 * crackable looks identical to a correct one.
 *
 * Argon2 is genuinely slow by design, so tests that derive a real key use deliberately
 * weak parameters. Where the *strength* of the parameters is what is under test, the
 * validator is exercised directly instead.
 */

/** The OWASP floor — the weakest thing `assertUsableKdfParams` will accept. */
const FAST_PARAMS = {
  alg: KDF_ID,
  memoryKib: 19_456,
  iterations: 2,
  parallelism: 1,
  salt: Buffer.from(randomBytes(16)).toString('base64'),
} as const;

const key = (): SecretBytes => SecretBytes.adopt(randomBytes(KEY_BYTES));
const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));

/** Flips the low bit of one byte, returning a copy. The canonical corruption probe. */
const flipBit = (bytes: Uint8Array, index = 0): Uint8Array => {
  const copy = Uint8Array.from(bytes);
  copy[index] = (copy[index] ?? 0) ^ 0b0000_0001;
  return copy;
};

describe('SecretBytes', () => {
  it('never reveals its contents through any stringification path', () => {
    const secret = SecretBytes.adopt(utf8('super-secret-key-material'));

    // Each of these paths has leaked a key into a log file in some real project.
    expect(String(secret)).not.toContain('super-secret');
    expect(`interpolated: ${secret.toString()}`).not.toContain('super-secret');
    expect(JSON.stringify({ secret })).not.toContain('super-secret');
    expect(JSON.stringify([secret])).not.toContain('super-secret');
    expect(String(secret)).toBe('[SecretBytes: redacted]');
  });

  it('zeroes its bytes on destroy', () => {
    const raw = utf8('sensitive');
    const secret = SecretBytes.adopt(raw);
    secret.destroy();
    expect(raw.every((byte) => byte === 0)).toBe(true);
  });

  it('refuses use after destroy rather than returning stale bytes', () => {
    const secret = key();
    secret.destroy();
    expect(() => secret.use((b) => b.length)).toThrow(/destroyed/i);
    expect(secret.destroyed).toBe(true);
  });

  it('is safe to destroy more than once, so `finally` blocks cannot fail', () => {
    const secret = key();
    secret.destroy();
    expect(() => {
      secret.destroy();
    }).not.toThrow();
  });

  it('copyOf does not take ownership of the caller buffer', () => {
    const raw = utf8('mine');
    const secret = SecretBytes.copyOf(raw);
    secret.destroy();
    expect(Buffer.from(raw).toString('utf8')).toBe('mine');
  });

  it('compares equal contents without leaking length-independent timing', () => {
    const a = SecretBytes.adopt(utf8('identical'));
    const b = SecretBytes.adopt(utf8('identical'));
    const c = SecretBytes.adopt(utf8('different'));
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});

describe('AES-256-GCM', () => {
  it('round-trips plaintext', () => {
    const k = key();
    const plaintext = utf8('the quick brown fox');
    expect(decrypt(k, encrypt(k, plaintext))).toEqual(plaintext);
  });

  it('round-trips through the base64 sealed-box form used in the header', () => {
    const k = key();
    const plaintext = utf8('header-stored value');
    const restored = decrypt(k, fromSealedBox(toSealedBox(encrypt(k, plaintext))));
    expect(restored).toEqual(plaintext);
  });

  it('generates a distinct nonce for every encryption — reuse would be catastrophic', () => {
    const k = key();
    const plaintext = utf8('same input every time');

    const nonces = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      nonces.add(Buffer.from(encrypt(k, plaintext).nonce).toString('hex'));
    }
    expect(nonces.size).toBe(200);
  });

  it('produces different ciphertext for identical plaintext', () => {
    const k = key();
    const a = encrypt(k, utf8('repeated'));
    const b = encrypt(k, utf8('repeated'));
    expect(Buffer.from(a.ciphertext).toString('hex')).not.toBe(
      Buffer.from(b.ciphertext).toString('hex')
    );
  });

  it('fails with the wrong key', () => {
    const box = encrypt(key(), utf8('secret'));
    expect(() => decrypt(key(), box)).toThrow();
  });

  it('detects a single flipped bit in the ciphertext', () => {
    const k = key();
    const box = encrypt(k, utf8('integrity matters here'));
    expect(() => decrypt(k, { ...box, ciphertext: flipBit(box.ciphertext) })).toThrow();
  });

  it('detects a flipped bit in the authentication tag', () => {
    const k = key();
    const box = encrypt(k, utf8('tagged'));
    expect(() => decrypt(k, { ...box, tag: flipBit(box.tag) })).toThrow();
  });

  it('detects a flipped bit in the nonce', () => {
    const k = key();
    const box = encrypt(k, utf8('nonced'));
    expect(() => decrypt(k, { ...box, nonce: flipBit(box.nonce) })).toThrow();
  });

  it('binds the ciphertext to its AAD — this is what protects the plaintext header', () => {
    const k = key();
    const aad = utf8('{"generation":1}');
    const box = encrypt(k, utf8('body'), aad);

    expect(decrypt(k, box, aad)).toEqual(utf8('body'));
    expect(() => decrypt(k, box, utf8('{"generation":2}'))).toThrow();
    expect(() => decrypt(k, box)).toThrow();
  });

  it('rejects a key of the wrong length rather than silently padding it', () => {
    const short = SecretBytes.adopt(randomBytes(16));
    expect(() => encrypt(short, utf8('x'))).toThrow(/32-byte key/);
  });

  it('rejects a malformed nonce or tag length', () => {
    const k = key();
    const box = encrypt(k, utf8('x'));
    expect(() => decrypt(k, { ...box, nonce: randomBytes(NONCE_BYTES - 1) })).toThrow(/nonce/);
    expect(() => decrypt(k, { ...box, tag: randomBytes(TAG_BYTES - 1) })).toThrow(/tag/);
  });
});

describe('Argon2id key derivation', () => {
  it('is deterministic for the same password and parameters', async () => {
    const a = await deriveKey({ password: 'correct horse', params: FAST_PARAMS });
    const b = await deriveKey({ password: 'correct horse', params: FAST_PARAMS });
    expect(a.equals(b)).toBe(true);
  });

  it('produces a different key for a different password', async () => {
    const a = await deriveKey({ password: 'password-one', params: FAST_PARAMS });
    const b = await deriveKey({ password: 'password-two', params: FAST_PARAMS });
    expect(a.equals(b)).toBe(false);
  });

  it('produces a different key for a different salt', async () => {
    const other = { ...FAST_PARAMS, salt: Buffer.from(randomBytes(16)).toString('base64') };
    const a = await deriveKey({ password: 'same', params: FAST_PARAMS });
    const b = await deriveKey({ password: 'same', params: other });
    expect(a.equals(b)).toBe(false);
  });

  it('produces a different key when any cost parameter changes', async () => {
    const a = await deriveKey({ password: 'same', params: FAST_PARAMS });
    const b = await deriveKey({
      password: 'same',
      params: { ...FAST_PARAMS, iterations: FAST_PARAMS.iterations + 1 },
    });
    expect(a.equals(b)).toBe(false);
  });

  it('derives exactly a 32-byte key', async () => {
    const derived = await deriveKey({ password: 'x', params: FAST_PARAMS });
    expect(derived.length).toBe(KEY_BYTES);
  });

  it('gives every new vault a fresh random salt', () => {
    const salts = new Set(Array.from({ length: 50 }, () => newKdfParams().salt));
    expect(salts.size).toBe(50);
  });
});

describe('KDF calibration', () => {
  it('never returns parameters weaker than the shipped default', async () => {
    // The failure this guards against is subtle and backwards: the loop exits as soon as
    // it reaches the time target, so on a fast machine it could settle below the default
    // and produce a WEAKER vault than a slow machine would. A powerful computer must not
    // buy the user less security.
    const { params } = await calibrateKdf(1, 2_000);
    expect(params.memoryKib).toBeGreaterThanOrEqual(DEFAULT_KDF_PARAMS.memoryKib);
  }, 30_000);

  it('returns parameters that pass validation and actually derive a key', async () => {
    const { params, measuredMs } = await calibrateKdf(1, 2_000);
    const withSalt = { ...params, salt: newKdfParams().salt };

    expect(() => {
      assertUsableKdfParams(withSalt);
    }).not.toThrow();
    expect(measuredMs).toBeGreaterThan(0);

    const derived = await deriveKey({ password: 'x', params: withSalt });
    expect(derived.length).toBe(KEY_BYTES);
  }, 30_000);
});

describe('KDF parameter validation — the header is attacker-controlled', () => {
  it('accepts the defaults', () => {
    expect(() => {
      assertUsableKdfParams(newKdfParams());
    }).not.toThrow();
  });

  it('rejects a downgraded memory cost, which would silently weaken the vault', () => {
    expect(() => {
      assertUsableKdfParams({ ...FAST_PARAMS, memoryKib: 8 });
    }).toThrow(VaultError);
  });

  it('rejects an absurd memory cost, which would hang or OOM the app', () => {
    expect(() => {
      assertUsableKdfParams({ ...FAST_PARAMS, memoryKib: 68_719_476_736 });
    }).toThrow(/above the maximum/);
  });

  it('rejects too few iterations and an absurd iteration count', () => {
    expect(() => {
      assertUsableKdfParams({ ...FAST_PARAMS, iterations: 1 });
    }).toThrow(VaultError);
    expect(() => {
      assertUsableKdfParams({ ...FAST_PARAMS, iterations: 10_000 });
    }).toThrow(VaultError);
  });

  it('rejects a short salt', () => {
    expect(() => {
      assertUsableKdfParams({ ...FAST_PARAMS, salt: Buffer.from('tiny').toString('base64') });
    }).toThrow(/salt/);
  });

  it('rejects a non-integer cost', () => {
    expect(() => {
      assertUsableKdfParams({ ...FAST_PARAMS, iterations: 2.5 });
    }).toThrow(/not an integer/);
  });

  it('rejects an unknown algorithm rather than falling back to one', () => {
    expect(() => {
      assertUsableKdfParams({ ...FAST_PARAMS, alg: 'pbkdf2' as unknown as typeof KDF_ID });
    }).toThrow(/unknown algorithm/);
  });
});

describe('envelope encryption', () => {
  it('unwraps the data key with the right password', async () => {
    const { keys, wrappedDek } = await createVaultKeys('master', FAST_PARAMS);
    const reopened = await unlock('master', FAST_PARAMS, wrappedDek);
    expect(reopened.dek.equals(keys.dek)).toBe(true);
  });

  it('reports a wrong password as WRONG_PASSWORD, not a raw crypto error', async () => {
    const { wrappedDek } = await createVaultKeys('master', FAST_PARAMS);
    await expect(unlock('not-the-master', FAST_PARAMS, wrappedDek)).rejects.toMatchObject({
      code: 'WRONG_PASSWORD',
    });
  });

  it('marks a wrong password as recoverable, so the UI can offer a retry', async () => {
    const { wrappedDek } = await createVaultKeys('master', FAST_PARAMS);
    const error = await unlock('wrong', FAST_PARAMS, wrappedDek).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).isRecoverable).toBe(true);
  });

  it('never mentions the password in the error message', async () => {
    const { wrappedDek } = await createVaultKeys('master', FAST_PARAMS);
    const error = await unlock('hunter2-my-real-password', FAST_PARAMS, wrappedDek).catch(
      (e: unknown) => e
    );
    expect(String(error)).not.toContain('hunter2');
  });

  it('detects tampering with the wrapped key', async () => {
    const { wrappedDek } = await createVaultKeys('master', FAST_PARAMS);
    const flipped = flipBit(new Uint8Array(Buffer.from(wrappedDek.ciphertext, 'base64')));
    const tampered = { ...wrappedDek, ciphertext: Buffer.from(flipped).toString('base64') };

    await expect(unlock('master', FAST_PARAMS, tampered)).rejects.toBeInstanceOf(VaultError);
  });

  it('generates a distinct data key for every vault', () => {
    const keys = Array.from({ length: 20 }, () => generateDek());
    const seen = new Set(keys.map((k) => k.use((b) => Buffer.from(b).toString('hex'))));
    expect(seen.size).toBe(20);
  });

  it('changes the master password without changing the data key', async () => {
    // This is the entire point of envelope encryption: the vault body is untouched, so a
    // password change cannot half-succeed and cannot lose data.
    const { keys, wrappedDek } = await createVaultKeys('old-password', FAST_PARAMS);
    const newParams = newKdfParams({
      memoryKib: FAST_PARAMS.memoryKib,
      iterations: 2,
      parallelism: 1,
    });
    const rewrapped = await rewrapForNewPassword(keys.dek, 'new-password', newParams);

    const reopened = await unlock('new-password', newParams, rewrapped);
    expect(reopened.dek.equals(keys.dek)).toBe(true);

    // And the old password no longer opens the new wrapping.
    await expect(unlock('old-password', newParams, rewrapped)).rejects.toMatchObject({
      code: 'WRONG_PASSWORD',
    });

    // The original wrapping is unaffected — nothing was mutated in place.
    const viaOld = await unlock('old-password', FAST_PARAMS, wrappedDek);
    expect(viaOld.dek.equals(keys.dek)).toBe(true);
  });

  it('supports several independent wrappings of one data key', async () => {
    // The shape that biometric unlock, key files and hardware keys all use.
    const dek = generateDek();
    const kekA = await deriveKey({ password: 'password-path', params: FAST_PARAMS });
    const kekB = await deriveKey({ password: 'biometric-path', params: FAST_PARAMS });

    const wrappedA = wrapDek(kekA, dek);
    const wrappedB = wrapDek(kekB, dek);

    expect(unwrapDek(kekA, wrappedA).equals(dek)).toBe(true);
    expect(unwrapDek(kekB, wrappedB).equals(dek)).toBe(true);
    // Revoking one wrapping cannot affect the other.
    expect(() => unwrapDek(kekA, wrappedB)).toThrow(VaultError);
  });
});

describe('randomness', () => {
  it('produces unbiased integers across the whole range', () => {
    // A modulo-biased generator shows up here as a systematically over-represented
    // low bucket. With 60k samples over 7 buckets the expected count is ~8571.
    const buckets = new Array<number>(7).fill(0);
    for (let i = 0; i < 60_000; i += 1) {
      const bucket = randomInt(7);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }

    for (const count of buckets) {
      expect(count).toBeGreaterThan(7_800);
      expect(count).toBeLessThan(9_400);
    }
  });

  it('always stays within bounds', () => {
    for (let i = 0; i < 5_000; i += 1) {
      const value = randomInt(10);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(10);
    }
  });

  it('handles a single-value range', () => {
    expect(randomInt(1)).toBe(0);
  });

  it('rejects an invalid range rather than returning nonsense', () => {
    expect(() => randomInt(0)).toThrow(RangeError);
    expect(() => randomInt(-1)).toThrow(RangeError);
    expect(() => randomInt(2.5)).toThrow(RangeError);
  });

  it('shuffles without dropping or duplicating elements', () => {
    const source = Array.from({ length: 100 }, (_, i) => i);
    const shuffled = shuffleInPlace([...source]);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(source);
  });

  it('actually reorders — a shuffle that returns the input is a real bug', () => {
    const source = Array.from({ length: 200 }, (_, i) => i);
    const shuffled = shuffleInPlace([...source]);
    expect(shuffled).not.toEqual(source);
  });
});
