// SPDX-License-Identifier: GPL-3.0-or-later
import type { KdfCost, MachineSettings, SettingsGateway } from '@shared/model/settings-plan.js';
import type { ConfigurableVaultSettings, SettingsSnapshot } from '@shared/model/settings-plan.js';

/**
 * The settings screen's connection to the main process.
 *
 * The screen is written against `SettingsGateway` rather than against `window.keyhold`
 * directly, for two reasons. The first is testing: `@testing-library/react` is not a
 * dependency here, so the only way to exercise this screen is to drive it against an
 * in-memory implementation (`fake-gateway.ts`). The second is that the IPC arrived in
 * pieces — writing the screen against a named seam kept the gap visible instead of hiding
 * it behind stubs that looked like they worked, and let it be closed one channel at a time.
 *
 * `createBridgeGateway` implements everything the bridge offers and refuses the rest with
 * the channel name in the message. A settings screen that silently pretends to save is worse
 * than one that says it cannot — and, as an audit found here, a gateway that *performs* the
 * change and then reports failure is worse than both.
 */

/**
 * The IPC surface still missing, and the payload each would carry.
 *
 * Data rather than prose so the failure message names the exact channel, and so the list
 * shrinks one line at a time as handlers land. It began with six; four have been deleted as
 * their channels appeared, and `settings-gateway.test.ts` fails if an entry here names a
 * channel `CHANNELS` already has — otherwise this becomes a stale inventory describing a
 * gap that closed months ago, which is the failure mode of every "still to do" list kept
 * next to the code rather than inside it.
 *
 * The two that remain are not settings writes. Both re-wrap the DEK, both must be atomic
 * against a real vault file, and both need their own slice with the re-wrap tested against
 * one — which is exactly why they are still here rather than quietly bundled in with a
 * boolean toggle.
 */
export interface RequiredChannel {
  readonly method: keyof SettingsGateway;
  readonly channel: string;
  readonly payload: string;
  readonly returns: string;
}

export const REQUIRED_CHANNELS: readonly RequiredChannel[] = [
  {
    method: 'changeMasterPassword',
    channel: 'kh:settings:change-master-password',
    payload: '(currentSecret: string, nextSecret: string)',
    returns: 'IpcResult<null>',
  },
  {
    method: 'rekey',
    channel: 'kh:settings:rekey',
    payload: '(currentSecret: string, cost: KdfCost)',
    returns: 'IpcResult<SettingsSnapshot>',
  },
];

/** Raised when the screen asks for something whose IPC handler is not registered yet. */
export class SettingsUnavailableError extends Error {
  readonly channel: string;

  constructor(method: keyof SettingsGateway) {
    const required = REQUIRED_CHANNELS.find((entry) => entry.method === method);
    const channel = required?.channel ?? `kh:settings:${method}`;
    super(
      `Settings are not wired up yet: this needs the ${channel} IPC channel, which Phase 14 has not registered. Nothing was changed.`
    );
    this.name = 'SettingsUnavailableError';
    this.channel = channel;
  }
}

function unavailable(method: keyof SettingsGateway): Promise<never> {
  return Promise.reject(new SettingsUnavailableError(method));
}

/**
 * The real gateway, over the preload bridge.
 *
 * Four of the six channels exist now. The two that do not — changing the master password
 * and re-keying — are envelope-crypto operations rather than settings writes: both re-wrap
 * the DEK and both must be atomic against a real vault file, which is a slice of its own.
 * They still refuse by name, which is the point of {@link REQUIRED_CHANNELS}: the list
 * shrinks one line at a time and the gap stays visible instead of being stubbed into
 * something that looks like it works.
 */
export function createBridgeGateway(): SettingsGateway {
  /**
   * Unwraps a result, or throws its message.
   *
   * The message comes from `toFailure` in the main process, which has already decided what
   * is safe to say — a validation failure names the field, an internal error says only that
   * something went wrong. So it is surfaced verbatim rather than replaced with something
   * vaguer here, which would throw away the half of it the user could act on.
   */
  const unwrap = <T>(result: { ok: true; value: T } | { ok: false; message: string }): T => {
    if (!result.ok) throw new Error(result.message);
    return result.value;
  };

  return {
    read: async () => unwrap(await window.keyhold.settings.read()),

    updateMachine: async (patch: Partial<MachineSettings>) =>
      unwrap(await window.keyhold.settings.updateMachine(patch)),

    updateVault: async (patch: Partial<ConfigurableVaultSettings>) =>
      unwrap(await window.keyhold.settings.updateVault(patch)),

    networkName: async (): Promise<string | null> => {
      const result = await window.keyhold.history.networkName();
      // A failure here is not an error the user should see: "we could not read the network
      // name" and "you are not on a named network" lead to the same answer on screen.
      return result.ok ? result.value : null;
    },

    changeMasterPassword: (_currentSecret: string, _nextSecret: string) =>
      unavailable('changeMasterPassword'),

    rekey: (_currentSecret: string, _cost: KdfCost) => unavailable('rekey'),

    clearAllHistory: async () => unwrap(await window.keyhold.settings.clearAllHistory()),

    setQuickUnlock: async (enabled: boolean): Promise<SettingsSnapshot> => {
      const result = enabled
        ? await window.keyhold.session.enrolQuickUnlock()
        : await window.keyhold.session.revokeQuickUnlock();
      if (!result.ok) throw new Error(result.message);

      // Re-read, rather than returning `unavailable('read')`.
      //
      // This used to do the enrol and *then* reject, so the screen caught the rejection and
      // announced "Not saved" — after the OS keystore had really been written. The user
      // turned quick unlock on, was told it failed, and walked away believing no copy of
      // their vault key existed while one did. Turning it off was quieter and worse: the key
      // was deleted, the failure was reported, and the toggle stayed reading "On".
      //
      // A gateway that performs an irreversible action and then reports failure is worse
      // than one that refuses up front, because the user's model of what happened is now
      // wrong in the direction that matters.
      return unwrap(await window.keyhold.settings.read());
    },
  };
}
