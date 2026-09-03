// SPDX-License-Identifier: GPL-3.0-or-later
import { CHANNELS } from '@shared/ipc/api.js';
import { KDF_UI_FLOOR, type SettingsGateway } from '@shared/model/settings-plan.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridgeGateway, REQUIRED_CHANNELS } from './settings-gateway.js';

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
      changeMasterPassword: () => Promise.resolve({ ok: true, value: null }),
      rekey: () => Promise.resolve({ ok: true, value: SNAPSHOT }),
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
    await expect(gateway.changeMasterPassword('old', 'new')).resolves.toBeUndefined();
    await expect(gateway.rekey('old', KDF_UI_FLOOR)).resolves.toBeDefined();
  });

  /**
   * Every method reaches the bridge — no stub survives here.
   *
   * This replaces what `REQUIRED_CHANNELS` used to guard. While the list had entries, an
   * unwired method was visible in the list itself; now that it is empty that test can no
   * longer fail, so the property moves to where it still has teeth. Driven off
   * `Object.keys` rather than a written-out list, so a method added to `SettingsGateway`
   * and stubbed rather than wired is caught without anyone remembering to add it here —
   * which is the failure this file exists for.
   */
  it('leaves no method unwired, whatever is added to the gateway later', async () => {
    installBridge();
    const gateway = createBridgeGateway();

    const args: Record<keyof SettingsGateway, readonly unknown[]> = {
      read: [],
      updateMachine: [{}],
      updateVault: [{}],
      networkName: [],
      changeMasterPassword: ['old', 'new'],
      rekey: ['old', KDF_UI_FLOOR],
      clearAllHistory: [],
      setQuickUnlock: [true],
    };

    // Every key on the object, not every key in `args`: a method missing from `args` fails
    // as an undefined lookup rather than being quietly skipped.
    for (const method of Object.keys(gateway) as (keyof SettingsGateway)[]) {
      const call = gateway[method] as (...rest: readonly unknown[]) => Promise<unknown>;
      // Settled to a string rather than asserted with `.resolves`, because the methods do
      // not agree on a return value — `changeMasterPassword` resolves to `undefined` on
      // purpose — and any matcher loose enough to accept all of them is loose enough to
      // pass on a rejection too.
      const settled = await call(...args[method]).then(
        () => 'resolved',
        (error: unknown) => `rejected: ${String(error)}`
      );
      expect(settled, `${method} did not reach the bridge`).toBe('resolved');
    }
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

describe('the inventory of missing channels', () => {
  it('names nothing the contract already has', () => {
    // The list shrank one line at a time as handlers landed, and is now empty. It stays,
    // rather than being deleted, so the next gap is recorded the same way — but note this
    // assertion cannot fail while the list is empty. The property it used to carry lives in
    // 'leaves no method unwired' above; this one only guards against a future entry being
    // added and then left behind after its channel lands.
    const registered = new Set<string>(Object.values(CHANNELS));
    const stale = REQUIRED_CHANNELS.filter((entry) => registered.has(entry.channel));

    expect(
      stale.map((entry) => entry.channel),
      'these channels exist now; delete their REQUIRED_CHANNELS entries and wire the gateway'
    ).toEqual([]);
  });
});
