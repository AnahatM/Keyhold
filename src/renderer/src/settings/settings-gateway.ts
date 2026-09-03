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
 * **Empty, and deliberately kept.** It began with six entries; all six have been deleted as
 * their handlers landed, the last two — changing the master password and re-keying — in the
 * slice that made them real. The list is data rather than prose so a failure message names
 * the exact channel, and `settings-gateway.test.ts` fails if an entry here names a channel
 * `CHANNELS` already has, which is what stopped it becoming a stale inventory describing a
 * gap that closed months ago.
 *
 * The type and the machinery stay because the next gap will want them, and because an empty
 * list is a stronger statement than a deleted one: it says the screen was audited against
 * the contract and nothing is stubbed, rather than leaving the reader to wonder whether the
 * inventory was removed because it was finished or because it was inconvenient.
 */
export interface RequiredChannel {
  readonly method: keyof SettingsGateway;
  readonly channel: string;
  readonly payload: string;
  readonly returns: string;
}

export const REQUIRED_CHANNELS: readonly RequiredChannel[] = [];

/**
 * The real gateway, over the preload bridge.
 *
 * Every channel the screen needs now exists. The last two to arrive — changing the master
 * password and re-keying — were held back deliberately: they are envelope-crypto operations
 * rather than settings writes, both re-wrap the data key, and both had to be atomic against
 * a real vault file, so they were a slice of their own rather than something bundled in
 * beside a boolean toggle.
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

    changeMasterPassword: async (currentSecret: string, nextSecret: string): Promise<void> => {
      unwrap(await window.keyhold.settings.changeMasterPassword(currentSecret, nextSecret));
    },

    rekey: async (currentSecret: string, cost: KdfCost) =>
      unwrap(await window.keyhold.settings.rekey(currentSecret, cost)),

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
