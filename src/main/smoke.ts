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
 * It verifies three things and quits:
 *   1. the app reaches `ready` and creates a window
 *   2. the renderer finishes loading without a crash
 *   3. the preload bridge is actually present on `window`
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
    window.webContents
      .executeJavaScript('typeof window.keyhold', true)
      .then((bridgeType: unknown) => {
        if (bridgeType === 'object') {
          finish(true, 'window created, renderer loaded, preload bridge present');
        } else {
          finish(
            false,
            `preload bridge missing (typeof window.keyhold === ${String(bridgeType)}) — check that the preload is CommonJS; a sandboxed preload cannot be ESM`
          );
        }
      })
      .catch((error: unknown) => {
        finish(false, `bridge probe threw: ${String(error)}`);
      });
  });
}
