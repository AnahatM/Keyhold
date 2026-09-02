// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KDF_ID, KEY_BYTES } from '@shared/format/types.js';
import { VaultError } from './errors.js';
import { KdfRunner } from './kdf-runner.js';
import { deriveKey } from './kdf.js';
import { randomBytes } from './random.js';

/**
 * The worker-thread KDF.
 *
 * Two things need proving, and only one of them is "does it compute the right answer":
 *
 *  1. **It agrees with the in-process implementation, byte for byte.** A worker that
 *     derived a subtly different key would produce vaults that only open through one code
 *     path — silent, and catastrophic once a vault has been saved with it.
 *
 *  2. **It genuinely leaves the calling thread free.** That is the entire reason the
 *     worker exists, and it is measured here rather than assumed.
 *
 * These tests run against the BUILT worker (`out/main/kdf-worker.js`), because that is
 * what ships. Testing a TypeScript source file the runtime never loads would not catch a
 * build misconfiguration — which is exactly the failure this arrangement is prone to.
 */

const WORKER_PATH = resolve('out/main/kdf-worker.js');
const BUILT = existsSync(WORKER_PATH);

/** The OWASP floor — fast enough for a test, still a real derivation. */
const FAST_PARAMS = {
  alg: KDF_ID,
  memoryKib: 19_456,
  iterations: 2,
  parallelism: 1,
  salt: Buffer.from(randomBytes(16)).toString('base64'),
} as const;

let runner: KdfRunner | undefined;

afterEach(() => {
  runner?.dispose();
  runner = undefined;
});

// The build is a prerequisite. Skipping loudly is better than a green run that proved
// nothing, so the reason is in the test name.
describe.skipIf(!BUILT)('the worker-thread KDF (requires `npm run build`)', () => {
  it('derives the same key as the in-process implementation', async () => {
    runner = new KdfRunner(WORKER_PATH);

    const viaWorker = await runner.derive('correct horse battery staple', FAST_PARAMS);
    const inProcess = await deriveKey({
      password: 'correct horse battery staple',
      params: FAST_PARAMS,
    });

    expect(viaWorker.equals(inProcess)).toBe(true);
    expect(viaWorker.length).toBe(KEY_BYTES);
  }, 60_000);

  it('leaves the calling thread free while it works', async () => {
    // The actual reason this module exists. If Argon2 ran inline, the event loop would be
    // blocked for the whole derivation and no timer could fire.
    runner = new KdfRunner(WORKER_PATH);

    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 5);

    try {
      await runner.derive('a password', FAST_PARAMS);
    } finally {
      clearInterval(interval);
    }

    // A blocked loop yields zero or one tick. A free one yields many.
    expect(ticks, 'the event loop was blocked during derivation').toBeGreaterThan(3);
  }, 60_000);

  it('handles several sequential derivations on one worker', async () => {
    runner = new KdfRunner(WORKER_PATH);

    const first = await runner.derive('password-one', FAST_PARAMS);
    const second = await runner.derive('password-two', FAST_PARAMS);
    const firstAgain = await runner.derive('password-one', FAST_PARAMS);

    expect(first.equals(second)).toBe(false);
    expect(first.equals(firstAgain)).toBe(true);
  }, 90_000);

  it('keeps concurrent requests distinct rather than crossing their replies', async () => {
    // Requests are correlated by id; getting that wrong would hand one caller another
    // caller's key, which is about the worst possible bug in this file.
    runner = new KdfRunner(WORKER_PATH);

    const [a, b] = await Promise.all([
      runner.derive('alpha', FAST_PARAMS),
      runner.derive('beta', FAST_PARAMS),
    ]);

    const expectedA = await deriveKey({ password: 'alpha', params: FAST_PARAMS });
    const expectedB = await deriveKey({ password: 'beta', params: FAST_PARAMS });

    expect(a.equals(expectedA)).toBe(true);
    expect(b.equals(expectedB)).toBe(true);
  }, 90_000);

  it('rejects hostile parameters before spending anything on them', async () => {
    // Validated on this side, so a header asking for 64 GiB never reaches the allocation.
    runner = new KdfRunner(WORKER_PATH);

    await expect(
      runner.derive('x', { ...FAST_PARAMS, memoryKib: 68_719_476_736 })
    ).rejects.toBeInstanceOf(VaultError);

    await expect(runner.derive('x', { ...FAST_PARAMS, memoryKib: 8 })).rejects.toBeInstanceOf(
      VaultError
    );
  });

  it('recovers after being disposed mid-session', async () => {
    runner = new KdfRunner(WORKER_PATH);
    await runner.derive('first', FAST_PARAMS);

    runner.dispose();

    // A new worker is created on demand, so disposal is not a one-way door.
    const afterDispose = await runner.derive('second', FAST_PARAMS);
    expect(afterDispose.length).toBe(KEY_BYTES);
  }, 90_000);

  it('is safe to dispose more than once', () => {
    runner = new KdfRunner(WORKER_PATH);
    expect(() => {
      runner?.dispose();
      runner?.dispose();
    }).not.toThrow();
  });
});
