// SPDX-License-Identifier: GPL-3.0-or-later
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

import type { IpcResult } from '@shared/ipc/api.js';

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
    registerIpcHandlers({
      session: stubContext(),
      appVersion: '0.0.0',
      // A directory that is never written to: registration stores closures and runs none of
      // them, so nothing here reaches the filesystem.
      userDataPath: join(tmpdir(), 'keyhold-register-test'),
      getWindow: () => null,
    });
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

  /*
   * The sender check, finding S8.
   *
   * Every handler shares one wrapper, so one channel is enough to establish that the check
   * runs — but *which* channel matters: it has to be one whose body would be observable if
   * the refusal did not happen. `appGetVersion` is the wrong choice, because it answers from
   * a constant either way and the assertion would pass on a wrapper that checked nothing.
   * `vaultSummary` reaches the stub context instead, so a refusal and a success are plainly
   * different results.
   *
   * Fault injection performed: deleting the `if (!fromTopFrame(event))` block fails all three
   * refusal tests, which then return `ok: true`. Changing `frame.parent === null` to
   * `frame.parent !== undefined` fails "refuses a subframe". The last test was weaker on its
   * first draft — it asserted only that the sender's URL was absent from the result, which a
   * wrapper checking nothing also satisfies; it now asserts the refusal too.
   */
  const invoke = async (channel: string, event: unknown): Promise<IpcResult<unknown>> => {
    const listener = handled.get(channel) as (
      event: unknown,
      ...args: unknown[]
    ) => Promise<IpcResult<unknown>>;
    return listener(event);
  };

  const CHANNEL = CHANNELS.vaultSummary;

  it('answers the window’s own top frame', async () => {
    const result = await invoke(CHANNEL, { senderFrame: { parent: null } });
    expect(result.ok).toBe(true);
  });

  it('refuses a subframe, which nothing in this app should ever be', async () => {
    const result = await invoke(CHANNEL, { senderFrame: { parent: { parent: null } } });
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN_SENDER' });
  });

  it('refuses a frame that has already gone', async () => {
    // `senderFrame` is null once the frame is destroyed. Answering a caller that no longer
    // exists is at best wasted work against the vault.
    const result = await invoke(CHANNEL, { senderFrame: null });
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN_SENDER' });
  });

  it('refuses without echoing anything about the sender', async () => {
    const result = await invoke(CHANNEL, {
      senderFrame: { parent: { parent: null }, url: 'https://evil.example/probe' },
    });
    // Both halves, in one test, because the "says nothing" half alone cannot fail: a wrapper
    // with no check at all returns a success that also happens not to mention the sender.
    // That was found by injecting the removal and watching this pass — the assertion has to
    // be anchored to the refusal to mean anything.
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('evil.example');
  });
});
