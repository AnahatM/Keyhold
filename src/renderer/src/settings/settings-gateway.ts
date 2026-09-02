// SPDX-License-Identifier: GPL-3.0-or-later
import type { KdfCost, MachineSettings, SettingsGateway } from '@shared/model/settings-plan.js';
import type { ConfigurableVaultSettings, SettingsSnapshot } from '@shared/model/settings-plan.js';

/**
 * The settings screen's connection to the main process.
 *
 * The screen is written against `SettingsGateway` rather than against `window.keyhold`
 * directly, for two reasons. The first is testing: `@testing-library/react` is not a
 * dependency here, so the only way to exercise this screen is to drive it against an
 * in-memory implementation (`fake-gateway.ts`). The second is that **Phase 14's IPC does
 * not exist yet** — none of the channels below are registered, and writing the screen
 * against a named seam keeps the gap visible instead of hiding it behind stubs that look
 * like they work.
 *
 * `createBridgeGateway` implements the two operations the bridge already offers and
 * refuses the rest with the channel name in the message. A settings screen that silently
 * pretends to save is worse than one that says it cannot.
 */

/**
 * The IPC surface Phase 14 has to add, and the payload each carries.
 *
 * Kept here as data rather than prose so the failure message names the exact missing
 * channel — and so this list is the thing that gets deleted, one line at a time, as the
 * handlers land. Channel naming follows `kh:<domain>:<action>`, and each of these belongs
 * in `CHANNELS` in `@shared/ipc/api.ts` alongside a `SettingsApi` namespace.
 */
export interface RequiredChannel {
  readonly method: keyof SettingsGateway;
  readonly channel: string;
  readonly payload: string;
  readonly returns: string;
}

export const REQUIRED_CHANNELS: readonly RequiredChannel[] = [
  {
    method: 'read',
    channel: 'kh:settings:read',
    payload: '()',
    returns: 'IpcResult<SettingsSnapshot>',
  },
  {
    method: 'updateMachine',
    channel: 'kh:settings:update-machine',
    payload: '(patch: Partial<MachineSettings>)',
    returns: 'IpcResult<SettingsSnapshot>',
  },
  {
    method: 'updateVault',
    channel: 'kh:settings:update-vault',
    payload: '(patch: Partial<ConfigurableVaultSettings>)',
    returns: 'IpcResult<SettingsSnapshot>',
  },
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
  {
    method: 'clearAllHistory',
    channel: 'kh:settings:clear-all-history',
    payload: '()',
    returns: 'IpcResult<number> — versions removed',
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
 * Two methods work today because their channels already exist for other features:
 * `history.networkName` (added for exactly this screen) and `session.revokeQuickUnlock`.
 * Everything else rejects with the channel it needs.
 */
export function createBridgeGateway(): SettingsGateway {
  return {
    read: () => unavailable('read'),

    updateMachine: (_patch: Partial<MachineSettings>) => unavailable('updateMachine'),

    updateVault: (_patch: Partial<ConfigurableVaultSettings>) => unavailable('updateVault'),

    networkName: async (): Promise<string | null> => {
      const result = await window.keyhold.history.networkName();
      // A failure here is not an error the user should see: "we could not read the network
      // name" and "you are not on a named network" lead to the same answer on screen.
      return result.ok ? result.value : null;
    },

    changeMasterPassword: (_currentSecret: string, _nextSecret: string) =>
      unavailable('changeMasterPassword'),

    rekey: (_currentSecret: string, _cost: KdfCost) => unavailable('rekey'),

    clearAllHistory: () => unavailable('clearAllHistory'),

    setQuickUnlock: async (enabled: boolean): Promise<SettingsSnapshot> => {
      const result = enabled
        ? await window.keyhold.session.enrolQuickUnlock()
        : await window.keyhold.session.revokeQuickUnlock();
      if (!result.ok) throw new Error(result.message);
      // The enrolment really has changed at this point; re-reading is what fails, because
      // `read` needs the channel that does not exist yet.
      return unavailable('read');
    },
  };
}
