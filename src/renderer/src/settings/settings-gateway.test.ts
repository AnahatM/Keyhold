// SPDX-License-Identifier: GPL-3.0-or-later
import { CHANNELS } from '@shared/ipc/api.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBridgeGateway,
  REQUIRED_CHANNELS,
  SettingsUnavailableError,
} from './settings-gateway.js';

/**
 * Guard: the gateway never reports a failure for something that succeeded.
 *
 * `setQuickUnlock` used to perform the real enrol — writing a copy of the vault key into
 * the OS keystore — and *then* reject, because re-reading needed a channel that did not
 * exist yet. The screen caught the rejection and announced "Not saved". The user turned
 * quick unlock on, was told it failed, and walked away believing no keystore copy of their
 * key existed while one did.
 *
 * Turning it off was quieter and worse: the key was deleted, the failure was reported, and
 * the toggle stayed reading "On".
 *
 * A gateway that performs an irreversible action and then reports failure is worse than one
 * that refuses up front, because the user's model of what happened is now wrong in the
 * direction that matters. That is the property asserted here, and it is asserted as
 * "the side effect and the report agree", not as "this particular call returns a value" —
 * so it keeps holding when the two remaining channels land.
 */

interface Recorded {
  readonly enrolled: number;
  readonly revoked: number;
  readonly read: number;
}

const SNAPSHOT = {
  machine: {},
  vault: null,
  vaultPath: null,
  vaultDisplayName: null,
  kdf: null,
  quickUnlock: { available: true, enrolled: true, promptsForBiometrics: false, description: 'x' },
  historyVersionCount: 0,
};

function installBridge(overrides: Record<string, unknown> = {}): Recorded {
  const counts = { enrolled: 0, revoked: 0, read: 0 };
  const bridge = {
    session: {
      enrolQuickUnlock: () => {
        counts.enrolled += 1;
        return Promise.resolve({ ok: true, value: {} });
      },
      revokeQuickUnlock: () => {
        counts.revoked += 1;
        return Promise.resolve({ ok: true, value: {} });
      },
    },
    settings: {
      read: () => {
        counts.read += 1;
        return Promise.resolve({ ok: true, value: SNAPSHOT });
      },
      updateMachine: () => Promise.resolve({ ok: true, value: SNAPSHOT }),
      updateVault: () => Promise.resolve({ ok: true, value: SNAPSHOT }),
      clearAllHistory: () => Promise.resolve({ ok: true, value: 7 }),
    },
    history: { networkName: () => Promise.resolve({ ok: true, value: 'Home' }) },
    ...overrides,
  };
  vi.stubGlobal('window', { keyhold: bridge });
  return counts;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('setQuickUnlock', () => {
  it('reports success when the enrolment succeeded', async () => {
    const counts = installBridge();
    await expect(createBridgeGateway().setQuickUnlock(true)).resolves.toMatchObject({
      quickUnlock: { enrolled: true },
    });
    expect(counts.enrolled).toBe(1);
  });

  it('reports success when the revocation succeeded', async () => {
    const counts = installBridge();
    await expect(createBridgeGateway().setQuickUnlock(false)).resolves.toBeDefined();
    expect(counts.revoked).toBe(1);
    expect(counts.enrolled).toBe(0);
  });

  it('never rejects after the keystore has already been written', async () => {
    // The regression, stated as the property rather than as the call. If this ever rejects
    // while `enrolled` is 1, the user has a copy of their vault key they have been told
    // does not exist.
    const counts = installBridge();
    let rejected = false;
    try {
      await createBridgeGateway().setQuickUnlock(true);
    } catch {
      rejected = true;
    }
    expect(rejected && counts.enrolled > 0).toBe(false);
  });

  it('does report a failure the enrolment itself reported', async () => {
    // The other half: a gateway that never fails is not honest either, it is just wrong in
    // the opposite direction.
    installBridge({
      session: {
        enrolQuickUnlock: () =>
          Promise.resolve({ ok: false, message: 'The keystore refused', recoverable: true }),
        revokeQuickUnlock: () => Promise.resolve({ ok: true, value: {} }),
      },
    });
    await expect(createBridgeGateway().setQuickUnlock(true)).rejects.toThrow(
      'The keystore refused'
    );
  });
});

describe('the channels that exist', () => {
  it('are used rather than refused', async () => {
    const gateway = createBridgeGateway();
    installBridge();

    await expect(gateway.read()).resolves.toBeDefined();
    await expect(gateway.updateMachine({})).resolves.toBeDefined();
    await expect(gateway.updateVault({})).resolves.toBeDefined();
    await expect(gateway.clearAllHistory()).resolves.toBe(7);
  });

  it('surface the main process message rather than a vaguer one', async () => {
    installBridge({
      settings: {
        read: () =>
          Promise.resolve({ ok: false, message: 'path must be absolute', recoverable: false }),
      },
    });
    await expect(createBridgeGateway().read()).rejects.toThrow('path must be absolute');
  });
});

describe('the channels that do not exist yet', () => {
  it('refuse by name rather than pretending', async () => {
    installBridge();
    const gateway = createBridgeGateway();
    await expect(gateway.changeMasterPassword('a', 'b')).rejects.toBeInstanceOf(
      SettingsUnavailableError
    );
    await expect(
      gateway.rekey('a', { memoryKib: 1, iterations: 1, parallelism: 1 })
    ).rejects.toBeInstanceOf(SettingsUnavailableError);
  });

  it('are exactly the ones REQUIRED_CHANNELS still lists as missing', () => {
    // The list is meant to shrink one line at a time as handlers land. This is what stops
    // it from becoming a stale inventory that describes a gap closed months ago — every
    // entry naming a channel the contract already has is an entry that should be gone.
    const registered = new Set<string>(Object.values(CHANNELS));
    const stale = REQUIRED_CHANNELS.filter((entry) => registered.has(entry.channel));

    expect(
      stale.map((entry) => entry.channel),
      'these channels exist now; delete their REQUIRED_CHANNELS entries and wire the gateway'
    ).toEqual([]);
  });
});
