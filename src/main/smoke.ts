// SPDX-License-Identifier: GPL-3.0-or-later
import { app, type BrowserWindow } from 'electron';

/**
 * Headless-ish launch smoke check, enabled only by `KEYHOLD_SMOKE=1`.
 *
 * This exists because a whole class of Electron defects is invisible to the build and
 * to unit tests, and only appears when the app actually starts. The one that motivated
 * it: a sandboxed preload emitted as ESM builds cleanly, launches cleanly, and simply
 * never runs — leaving `window.keyhold` undefined and every feature dead, with no error
 * anywhere. Nothing short of a real launch catches that.
 *
 * It verifies four things and quits:
 *   1. the app reaches `ready` and creates a window
 *   2. the renderer finishes loading without a crash
 *   3. the preload bridge is actually present on `window`
 *   4. a real IPC round-trip works end to end — bridge → ipcRenderer → a registered
 *      ipcMain handler → a structured result. Unit tests exercise the handler function;
 *      only this catches a handler that was never registered, a channel name that drifted
 *      between the contract and the preload, or a payload that fails to serialise.
 *
 * Never active in a normal run. CI calls it in Phase 18.
 */

const SMOKE_TIMEOUT_MS = 20_000;

export function isSmokeRun(): boolean {
  return process.env.KEYHOLD_SMOKE === '1';
}

function finish(ok: boolean, detail: string): void {
  // Deliberately stdout, not a logger: the CI job greps for these exact markers.
  process.stdout.write(`${ok ? 'SMOKE-PASS' : 'SMOKE-FAIL'} ${detail}\n`);
  app.exit(ok ? 0 : 1);
}

export function runSmokeCheck(window: BrowserWindow): void {
  const timer = setTimeout(() => {
    finish(false, 'timed out before the renderer finished loading');
  }, SMOKE_TIMEOUT_MS);

  window.webContents.once('render-process-gone', (_event, details) => {
    clearTimeout(timer);
    finish(false, `renderer process gone: ${details.reason}`);
  });

  window.webContents.once('did-fail-load', (_event, code, description) => {
    clearTimeout(timer);
    finish(false, `renderer failed to load: ${code} ${description}`);
  });

  window.webContents.once('did-finish-load', () => {
    clearTimeout(timer);
    // Probes the bridge, then makes a real call. `vault.summary()` is chosen because it
    // is safe with nothing open — it must answer `{ ok: true, value: null }`.
    const probe = `
      (async () => {
        if (typeof window.keyhold !== 'object') return { stage: 'bridge', ok: false };
        const result = await window.keyhold.vault.summary();
        return { stage: 'ipc', ok: result.ok === true && result.value === null, result };
      })()
    `;

    window.webContents
      .executeJavaScript(probe, true)
      .then((outcome: unknown) => {
        const report = outcome as { stage?: string; ok?: boolean; result?: unknown };

        if (report.stage === 'bridge') {
          finish(
            false,
            'preload bridge missing (window.keyhold is not an object) — check that the preload is CommonJS; a sandboxed preload cannot be ESM'
          );
          return;
        }
        if (report.ok !== true) {
          finish(
            false,
            `IPC round-trip returned an unexpected result: ${JSON.stringify(report.result)}`
          );
          return;
        }
        finish(true, 'window created, renderer loaded, preload bridge present, IPC round-trip OK');
      })
      .catch((error: unknown) => {
        finish(false, `smoke probe threw: ${String(error)}`);
      });
  });
}
