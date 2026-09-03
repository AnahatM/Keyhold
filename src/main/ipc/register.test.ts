// SPDX-License-Identifier: GPL-3.0-or-later
import { ALL_CHANNELS, CHANNELS } from '@shared/ipc/api.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guard: every declared channel has a handler, and every handler has a declared channel.
 *
 * `CHANNELS` is the contract. The preload invokes by name from it, the renderer's gateways
 * are typed against it, and `ALL_CHANNELS` is the allow-list. None of that notices when a
 * name is declared and nothing on the main side answers to it — the renderer calls, Electron
 * finds no handler, and the promise rejects with a message about an unregistered channel
 * that surfaces as a generic failure somewhere in a dialog.
 *
 * That is not hypothetical. Adding a channel group is four edits in four files, and the one
 * most easily forgotten is the handler, because the other three are what make the call site
 * compile. This test is the fourth edit refusing to be skipped.
 *
 * The reverse direction matters too, though for a different reason: a handler registered on
 * a string that is not in `CHANNELS` is a channel outside the allow-list, reachable by
 * anything that can guess the name and invisible to every review that reads the contract.
 */

const handled = new Map<string, unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: unknown) => {
      handled.set(channel, listener);
    },
  },
  dialog: {},
  app: { isPackaged: false },
}));

/**
 * A context that satisfies the handlers' *registration*, not their execution.
 *
 * Every member is a stub: `registerIpcHandlers` only stores closures, so nothing here is
 * called. Built with a Proxy rather than by enumerating the service surface, because a
 * hand-written double would need updating every time a handler reaches for a new vault
 * method — which is a second list, and one whose drift shows up as this test failing for a
 * reason that has nothing to do with what it asserts.
 */
function stubContext(): never {
  const stub: unknown = new Proxy(() => undefined, {
    get: (_target, property) => (property === 'then' ? undefined : stub),
    apply: () => stub,
  });
  return stub as never;
}

describe('IPC registration', () => {
  beforeEach(async () => {
    handled.clear();
    vi.resetModules();
    const { registerIpcHandlers } = await import('./register.js');
    registerIpcHandlers({ session: stubContext(), appVersion: '0.0.0', getWindow: () => null });
  });

  it('registers a handler for every declared channel', () => {
    const missing = ALL_CHANNELS.filter((channel) => !handled.has(channel));
    // Named, not counted: a failure has to say *which* channel, or the next person has to
    // diff two lists by hand to find out.
    expect(missing).toEqual([]);
  });

  it('registers nothing that is not a declared channel', () => {
    const declared = new Set<string>(ALL_CHANNELS);
    expect([...handled.keys()].filter((channel) => !declared.has(channel))).toEqual([]);
  });

  it('declares no channel twice under two names', () => {
    // `CHANNELS` is spread together from several groups, so two groups could name the same
    // string. The second `ipcMain.handle` on a channel throws in Electron at startup — which
    // is a good failure, but at startup, in a packaged build, after it has shipped.
    const names = Object.values(CHANNELS);
    expect(names.length).toBe(new Set(names).size);
  });
});
