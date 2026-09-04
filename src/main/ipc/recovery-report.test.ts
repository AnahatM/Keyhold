// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS, type IpcResult } from '@shared/ipc/api.js';

/**
 * `kh:recovery:save-report`, and the two refusals nothing was asserting.
 *
 * The diagnostics report is held in the **main process** between being produced and being
 * saved, rather than accepted back from the renderer. That decision is argued in
 * `register.ts`: taking it back would mean validating a large nested structure at the
 * boundary and then writing renderer-supplied text into a file the user believes Keyhold
 * wrote. Two obligations follow from it, and until now neither was tested.
 *
 *  1. **Saving before diagnosing is refused**, rather than writing an empty or stale file.
 *  2. **The held report is dropped on lock.** It describes the vault that was open — how many
 *     records, which structural problems, what the container looks like — and keeping it past
 *     a lock would leave a small profile of that vault in memory after the event whose entire
 *     meaning is that nothing vault-derived is still there. It is the same obligation the
 *     breach client's range cache has, and that one has a test.
 *
 * ## Why this file executes the handlers rather than only registering them
 *
 * `register.test.ts` deliberately stops at registration — it asserts every channel has a
 * handler and every handler a channel, and its context is a Proxy that would explode if
 * anything were actually called. That is the right shape for the question it asks and the
 * wrong one for this: "does the refusal happen" cannot be answered without running the
 * refusal. So the same Proxy is used for the parts registration touches, with real objects
 * for the three things these two handlers reach at call time.
 */

const handled = new Map<string, (...args: unknown[]) => unknown>();
const saveDialog = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      handled.set(channel, listener);
    },
  },
  dialog: { showSaveDialog: saveDialog, showOpenDialog: vi.fn() },
  app: { isPackaged: false },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const { registerIpcHandlers } = await import('./register.js');

const directory = mkdtempSync(join(tmpdir(), 'keyhold-recovery-ipc-'));
const vaultPath = join(directory, 'test.keep');

/** Everything registration touches but these handlers do not. */
function stub(): never {
  const proxy: unknown = new Proxy(() => undefined, {
    get: (_target, property) => (property === 'then' ? undefined : proxy),
    apply: () => proxy,
  });
  return proxy as never;
}

/** Fired by the test to simulate the vault locking. */
let lockListeners: (() => void)[] = [];

function register(): void {
  handled.clear();
  lockListeners = [];

  const session = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === 'onLock') {
          return (listener: () => void) => {
            lockListeners.push(listener);
          };
        }
        if (property === 'vault') {
          return new Proxy(
            {},
            {
              get: (_v, member) => {
                // The two the diagnose handler actually calls. A vault path that exists on
                // disk is required: `diagnoseVault` reads the folder around it for real.
                if (member === 'summary') return () => ({ path: vaultPath });
                // No open document — the container half of the report is enough here, and a
                // real `VaultDocument` would drag the whole vault service into this file.
                if (member === 'documentUnsafeForDiagnostics') return () => null;
                return stub();
              },
            }
          );
        }
        return stub();
      },
    }
  );

  registerIpcHandlers({
    session: session as never,
    appVersion: '0.0.0-test',
    userDataPath: directory,
    getWindow: () => null,
  });
}

/**
 * Invokes a handler the way the window does.
 *
 * The event carries a top frame, because every handler is wrapped in a sender check that
 * refuses anything else — `senderFrame.parent === null` is what "the window's top frame"
 * means. Without it every call here returns `FORBIDDEN_SENDER` and the assertions below
 * would be testing the sender check rather than the handler, and passing for the wrong
 * reason. `register.test.ts` owns the sender check itself.
 *
 * Errors do not reject: the wrapper catches them and returns a scrubbed `IpcResult` failure,
 * deliberately, so nothing about the cause crosses the bridge. So a refusal is asserted as a
 * *result*, which is also how the renderer sees it.
 */
const invoke = async (channel: string): Promise<IpcResult<unknown>> => {
  const listener = handled.get(channel);
  expect(listener, `${channel} has no handler`).toBeDefined();
  return (await (listener as (...args: unknown[]) => Promise<unknown>)({
    senderFrame: { parent: null },
  })) as IpcResult<unknown>;
};

/** The value, or a readable failure — so an unexpected refusal names itself. */
function value<T>(result: IpcResult<T>): T {
  expect(result.ok, result.ok ? '' : `refused: ${result.message}`).toBe(true);
  return (result as { ok: true; value: T }).value;
}

beforeEach(() => {
  saveDialog.mockReset();
  register();
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('saving a diagnostics report', () => {
  it('refuses when nothing has been diagnosed', async () => {
    const result = await invoke(CHANNELS.recoverySaveReport);

    expect(result.ok).toBe(false);
    // And it refused before opening a dialog: a save dialog for a file that cannot be written
    // is a worse experience than the refusal, because the user picks a name first.
    expect(saveDialog).not.toHaveBeenCalled();
  });

  it('writes the report that was produced, once one has been', async () => {
    const target = join(directory, 'report.txt');
    saveDialog.mockResolvedValue({ canceled: false, filePath: target });

    value(await invoke(CHANNELS.recoveryDiagnose));
    const saved = value(await invoke(CHANNELS.recoverySaveReport));

    expect(saved).toBe('report.txt');
    const written = readFileSync(target, 'utf8');
    expect(written.length).toBeGreaterThan(0);
    // The rendered report, not a JSON dump of an object the renderer handed back.
    expect(written).toContain('Keyhold');
  });

  it('writes nothing when the dialog is cancelled', async () => {
    saveDialog.mockResolvedValue({ canceled: true, filePath: '' });

    value(await invoke(CHANNELS.recoveryDiagnose));
    expect(value(await invoke(CHANNELS.recoverySaveReport))).toBeNull();
  });

  it('drops the report on lock, and refuses again afterwards', async () => {
    saveDialog.mockResolvedValue({ canceled: false, filePath: join(directory, 'after-lock.txt') });

    value(await invoke(CHANNELS.recoveryDiagnose));
    expect(lockListeners.length).toBeGreaterThan(0);
    for (const listener of lockListeners) listener();

    // The refusal is the observable half. What it stands for is that a description of the
    // vault that was open — its size, its structural problems, its container — is not still
    // sitting in main-process memory after the lock.
    expect((await invoke(CHANNELS.recoverySaveReport)).ok).toBe(false);
    expect(saveDialog).not.toHaveBeenCalled();
  });
});
