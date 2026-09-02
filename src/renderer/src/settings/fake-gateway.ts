// SPDX-License-Identifier: GPL-3.0-or-later
import {
  DEFAULT_CONFIGURABLE_VAULT_SETTINGS,
  DEFAULT_KDF_COST,
  DEFAULT_MACHINE_SETTINGS,
  type ConfigurableVaultSettings,
  type KdfCost,
  type MachineSettings,
  type SettingsGateway,
  type SettingsSnapshot,
} from '@shared/model/settings-plan.js';

/**
 * An in-memory `SettingsGateway`, for tests.
 *
 * Not a mock library and not a stub that returns the same object every time: it holds real
 * state, so a test can change a setting, read it back, and assert the round trip — which is
 * the only way "reset restores exactly the defaults" can be checked at all.
 *
 * Two properties it deliberately has:
 *
 * **It never retains a password.** `changeMasterPassword` records only that it was called
 * and how long each string was. A fake that kept the plaintext would make it impossible to
 * write the test asserting the screen does not hold one either, and would quietly
 * normalise exactly the habit this codebase bans.
 *
 * **It records the raw request before clamping.** `lastRekeyRequest` is what the screen
 * asked for, not what the gateway accepted, so the guard that the UI cannot even *ask* for
 * a below-floor KDF cost is a real assertion rather than a test of the clamp.
 */

export interface PasswordChangeRecord {
  readonly currentLength: number;
  readonly nextLength: number;
}

export interface FakeSettingsGateway extends SettingsGateway {
  /** The current state, without going through `read()`. */
  readonly peek: () => SettingsSnapshot;
  /** Method names in call order, for asserting a control did not save twice. */
  readonly calls: readonly string[];
  /** Lengths only — never the passwords themselves. */
  readonly passwordChanges: readonly PasswordChangeRecord[];
  /** What the screen asked for, before any clamping the gateway does. */
  readonly rekeyRequests: readonly KdfCost[];
  /** Makes the next call of any method reject. One shot; used for fault injection. */
  readonly failNext: (message: string) => void;
}

export interface FakeGatewayOptions {
  readonly machine?: MachineSettings;
  readonly vault?: ConfigurableVaultSettings | null;
  readonly kdf?: KdfCost | null;
  readonly networkName?: string | null;
  readonly historyVersionCount?: number;
  readonly quickUnlockEnrolled?: boolean;
  readonly quickUnlockAvailable?: boolean;
}

export function createFakeGateway(options: FakeGatewayOptions = {}): FakeSettingsGateway {
  let machine: MachineSettings = options.machine ?? DEFAULT_MACHINE_SETTINGS;
  let vault: ConfigurableVaultSettings | null =
    options.vault === undefined ? DEFAULT_CONFIGURABLE_VAULT_SETTINGS : options.vault;
  let kdf: KdfCost | null = options.kdf === undefined ? DEFAULT_KDF_COST : options.kdf;
  let enrolled = options.quickUnlockEnrolled ?? false;
  const available = options.quickUnlockAvailable ?? true;
  const networkName = options.networkName ?? 'Fake Network 5G';
  const historyVersionCount = options.historyVersionCount ?? 0;

  const calls: string[] = [];
  const passwordChanges: PasswordChangeRecord[] = [];
  const rekeyRequests: KdfCost[] = [];
  let pendingFailure: string | null = null;

  function snapshot(): SettingsSnapshot {
    return {
      machine,
      vault,
      vaultPath: vault === null ? null : 'C:/vaults/fake.keep',
      vaultDisplayName: vault === null ? null : 'fake',
      kdf,
      quickUnlock: {
        available,
        enrolled,
        promptsForBiometrics: false,
        description:
          'Unlock without retyping your master password. The key is protected by Windows and tied to your Windows account — but anyone already signed in to this account can use it.',
      },
      historyVersionCount,
    };
  }

  /** Every method funnels through here, so one `failNext` covers all of them. */
  function guard<T>(method: string, produce: () => T): Promise<T> {
    calls.push(method);
    if (pendingFailure !== null) {
      const message = pendingFailure;
      pendingFailure = null;
      return Promise.reject(new Error(message));
    }
    try {
      return Promise.resolve(produce());
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return {
    peek: snapshot,
    calls,
    passwordChanges,
    rekeyRequests,

    failNext: (message: string): void => {
      pendingFailure = message;
    },

    read: () => guard('read', snapshot),

    updateMachine: (patch: Partial<MachineSettings>) =>
      guard('updateMachine', () => {
        machine = { ...machine, ...patch };
        return snapshot();
      }),

    updateVault: (patch: Partial<ConfigurableVaultSettings>) =>
      guard('updateVault', () => {
        if (vault === null) throw new Error('No vault is open.');
        vault = { ...vault, ...patch };
        return snapshot();
      }),

    networkName: () => guard('networkName', () => networkName),

    changeMasterPassword: (currentSecret: string, nextSecret: string) =>
      guard('changeMasterPassword', () => {
        passwordChanges.push({
          currentLength: currentSecret.length,
          nextLength: nextSecret.length,
        });
      }),

    rekey: (_currentSecret: string, cost: KdfCost) =>
      guard('rekey', () => {
        rekeyRequests.push(cost);
        kdf = cost;
        // Re-keying invalidates every quick-unlock enrolment, because each records the
        // vault generation it was made at. The fake models that rather than ignoring it.
        enrolled = false;
        return snapshot();
      }),

    clearAllHistory: () => guard('clearAllHistory', () => historyVersionCount),

    setQuickUnlock: (enabled: boolean) =>
      guard('setQuickUnlock', () => {
        if (enabled && !available) throw new Error('Quick unlock is unavailable on this system.');
        enrolled = enabled;
        return snapshot();
      }),
  };
}
