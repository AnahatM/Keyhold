// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes as nodeRandomBytes, randomUUID } from 'node:crypto';
import { SecretBytes } from './secret.js';

/**
 * The single source of randomness for the whole application.
 *
 * Everything security-relevant comes from here: salts, nonces, data keys, generated
 * passwords, chunk ids. `Math.random()` is banned by lint project-wide, and this module
 * exists so there is an obvious correct alternative rather than a rule with no
 * destination.
 */

export function randomBytes(length: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(length));
}

export function randomSecret(length: number): SecretBytes {
  return SecretBytes.adopt(randomBytes(length));
}

/** A v4 UUID from the platform CSPRNG. Used for vault and device identity. */
export function uuid(): string {
  return randomUUID();
}

/** 16 random bytes as 32 lowercase hex characters — the attachment chunk id format. */
export function randomChunkId(): string {
  return Buffer.from(randomBytes(16)).toString('hex');
}

/**
 * A uniformly distributed integer in `[0, maxExclusive)`.
 *
 * Uses rejection sampling rather than the obvious modulo, because modulo is biased
 * whenever the range does not divide the generator's output evenly. For a password
 * generator that bias is not academic: with a 62-character alphabet it makes some
 * characters measurably likelier than others, which shrinks the real search space.
 *
 * `randomInt` from `node:crypto` does this correctly too; this is the same guarantee in
 * one place, so the bias question never has to be re-answered at a call site.
 */
export function randomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError(`randomInt requires a positive integer bound, got ${maxExclusive}`);
  }
  if (maxExclusive === 1) return 0;

  // Smallest byte count that can represent the range, then reject anything landing in
  // the ragged tail above the largest exact multiple.
  const bytesNeeded = Math.ceil(Math.log2(maxExclusive) / 8);
  const range = 256 ** bytesNeeded;
  const limit = range - (range % maxExclusive);

  for (;;) {
    const buf = nodeRandomBytes(bytesNeeded);
    let value = 0;
    for (const byte of buf) value = value * 256 + byte;
    if (value < limit) return value % maxExclusive;
  }
}

/**
 * Fisher-Yates shuffle driven by `randomInt`.
 *
 * Used by the password generator to place the "one of each required class" characters,
 * where a biased shuffle would make their positions predictable.
 */
export function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const a = items[i] as T;
    const b = items[j] as T;
    items[i] = b;
    items[j] = a;
  }
  return items;
}

/** Uniform choice from a non-empty array. */
export function randomChoice<T>(items: readonly T[]): T {
  if (items.length === 0) throw new RangeError('randomChoice requires a non-empty array');
  return items[randomInt(items.length)] as T;
}
