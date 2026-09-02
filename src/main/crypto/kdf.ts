// SPDX-License-Identifier: GPL-3.0-or-later
import { argon2id } from 'hash-wasm';
import {
  DEFAULT_KDF_PARAMS,
  KDF_ID,
  KEY_BYTES,
  MAX_KDF_PARAMS,
  MIN_KDF_PARAMS,
  SALT_BYTES,
  type KdfParams,
} from '@shared/format/types.js';
import { badKdfParams } from './errors.js';
import { randomBytes } from './random.js';
import { SecretBytes } from './secret.js';

/**
 * Argon2id key derivation.
 *
 * Argon2id is memory-hard: cracking it requires the memory cost per guess, which is what
 * makes GPUs and ASICs — which have enormous parallelism but comparatively little fast
 * memory per core — far less effective than they are against PBKDF2 or bcrypt.
 *
 * The implementation is `hash-wasm`, pure WebAssembly. That is a deliberate trade
 * (decision D14): a native binding would be somewhat faster, but would add a compiled
 * artefact per platform to every build, and the same WASM implementation also serves the
 * KDBX importer, which needs an Argon2 supplied from outside.
 */

export interface DerivedKeyOptions {
  readonly password: string;
  readonly params: KdfParams;
}

/**
 * Validates parameters read from a file before they are used.
 *
 * This matters because the header is attacker-controlled: it is plaintext in a file
 * anyone can hand you. Without a ceiling, a hostile `.keep` declaring 64 GiB of memory
 * cost turns "open this file" into a denial of service. Without a floor, a downgraded
 * header could silently make a vault trivially crackable while still opening normally.
 */
export function assertUsableKdfParams(params: KdfParams): void {
  // TypeScript narrows `alg` to the literal 'argon2id', so this comparison looks
  // provably true to the compiler — but the value arrives from a file on disk that
  // anyone can write, where the type system guarantees nothing. The cast makes the
  // runtime reality explicit rather than suppressing the rule.
  const declaredAlg: string = params.alg;
  if (declaredAlg !== KDF_ID) {
    throw badKdfParams(`unknown algorithm "${declaredAlg}"`);
  }

  const checks: readonly [name: string, value: number, min: number, max: number][] = [
    ['memory', params.memoryKib, MIN_KDF_PARAMS.memoryKib, MAX_KDF_PARAMS.memoryKib],
    ['iterations', params.iterations, MIN_KDF_PARAMS.iterations, MAX_KDF_PARAMS.iterations],
    ['parallelism', params.parallelism, MIN_KDF_PARAMS.parallelism, MAX_KDF_PARAMS.parallelism],
  ];

  for (const [name, value, min, max] of checks) {
    if (!Number.isInteger(value)) throw badKdfParams(`${name} is not an integer`);
    if (value < min) throw badKdfParams(`${name} is ${value}, below the minimum of ${min}`);
    if (value > max) throw badKdfParams(`${name} is ${value}, above the maximum of ${max}`);
  }

  const saltBytes = Buffer.from(params.salt, 'base64');
  if (saltBytes.length < SALT_BYTES) {
    throw badKdfParams(`salt is ${saltBytes.length} bytes, minimum is ${SALT_BYTES}`);
  }
}

/** Fresh parameters for a new vault: the defaults, plus a new random salt. */
export function newKdfParams(overrides?: Partial<Omit<KdfParams, 'alg' | 'salt'>>): KdfParams {
  return {
    alg: KDF_ID,
    memoryKib: overrides?.memoryKib ?? DEFAULT_KDF_PARAMS.memoryKib,
    iterations: overrides?.iterations ?? DEFAULT_KDF_PARAMS.iterations,
    parallelism: overrides?.parallelism ?? DEFAULT_KDF_PARAMS.parallelism,
    salt: Buffer.from(randomBytes(SALT_BYTES)).toString('base64'),
  };
}

/**
 * Derives the 32-byte key-encryption key from the master password.
 *
 * The result is the KEK, never the key that encrypts the vault body — see `envelope.ts`
 * for why that indirection exists.
 */
export async function deriveKey({ password, params }: DerivedKeyOptions): Promise<SecretBytes> {
  assertUsableKdfParams(params);

  const derived = await argon2id({
    password,
    salt: new Uint8Array(Buffer.from(params.salt, 'base64')),
    memorySize: params.memoryKib,
    iterations: params.iterations,
    parallelism: params.parallelism,
    hashLength: KEY_BYTES,
    outputType: 'binary',
  });

  return SecretBytes.adopt(derived);
}

export interface CalibrationResult {
  readonly params: Omit<KdfParams, 'salt'>;
  /** Measured wall-clock time for one derivation at these settings. */
  readonly measuredMs: number;
}

/**
 * Picks Argon2 parameters that take roughly `targetMs` on *this* machine.
 *
 * Why calibrate rather than hardcode: the right cost is "as much as the user will
 * tolerate", and that depends entirely on the hardware. A fixed value is either
 * painfully slow on a netbook or far too cheap on a workstation. Because the chosen
 * parameters are written into the vault header, an old vault keeps opening with its
 * original settings even after the defaults rise — the two never get out of step.
 *
 * Memory is scaled rather than iterations because memory hardness is what actually
 * degrades an attacker's parallel hardware; more passes over a small buffer is a much
 * weaker defence for the same wall-clock cost.
 */
export async function calibrateKdf(targetMs = 500, budgetMs = 5_000): Promise<CalibrationResult> {
  const salt = Buffer.from(randomBytes(SALT_BYTES)).toString('base64');
  const iterations = DEFAULT_KDF_PARAMS.iterations;
  const parallelism = DEFAULT_KDF_PARAMS.parallelism;

  const measure = async (memoryKib: number): Promise<number> => {
    const started = performance.now();
    const key = await deriveKey({
      password: 'calibration-probe',
      params: { alg: KDF_ID, memoryKib, iterations, parallelism, salt },
    });
    key.destroy();
    return performance.now() - started;
  };

  // Start at the floor and double until we pass the target or run out of budget. This is
  // a handful of probes, not a search — precision here is worthless, since the machine
  // will be under different load next time anyway.
  let memoryKib: number = MIN_KDF_PARAMS.memoryKib;
  let measuredMs = await measure(memoryKib);
  const startedAt = performance.now();

  while (
    measuredMs < targetMs &&
    memoryKib * 2 <= MAX_KDF_PARAMS.memoryKib &&
    performance.now() - startedAt < budgetMs
  ) {
    const candidate = memoryKib * 2;
    const candidateMs = await measure(candidate);
    memoryKib = candidate;
    measuredMs = candidateMs;
  }

  // Never calibrate *below* the shipped default. On a fast machine the loop can reach
  // the target early; accepting that would mean a powerful computer produces a weaker
  // vault than a slow one, which is exactly backwards.
  const chosen = Math.max(memoryKib, DEFAULT_KDF_PARAMS.memoryKib);

  return {
    params: { alg: KDF_ID, memoryKib: chosen, iterations, parallelism },
    measuredMs,
  };
}
