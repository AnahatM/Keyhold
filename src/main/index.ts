// SPDX-License-Identifier: GPL-3.0-or-later
import { app, BrowserWindow } from 'electron';
import { registerIpcHandlers, unregisterIpcHandlers } from './ipc/register.js';
import { applySessionHardening, applyWebContentsHardening } from './security.js';
import { isSmokeRun, runSmokeCheck } from './smoke.js';
import { VaultService } from './vault/vault-service.js';
import { createMainWindow, focusMainWindow } from './window.js';

/** Baked in at build time by electron-vite. */
declare const APP_VERSION: string;

/**
 * The single vault instance for this process.
 *
 * One per process, not one per window: two services could hold the same file open and
 * race each other's atomic writes, which is the data-loss bug the single-instance lock
 * below also guards against from the other direction.
 */
const vault = new VaultService();

/**
 * Keyhold main process entry point.
 *
 * The main process owns every secret: the KEK, the DEK, and the decrypted vault.
 * Nothing here may send secret material to the renderer — see CLAUDE.md and
 * decision D13 in docs/12-Roadmap/02-Decision-Log.md.
 */

/**
 * Single-instance lock.
 *
 * Two Keyhold processes could hold the same vault file open and race each other's
 * atomic writes, which is a data-loss bug (goal G1). Rather than solving that, we
 * make it impossible: the second launch hands its arguments to the first and exits.
 */
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    focusMainWindow();
  });

  // Applies to every WebContents that will ever exist, including ones created by
  // code that forgets to call hardenWindow.
  app.on('web-contents-created', (_event, contents) => {
    applyWebContentsHardening(contents);
  });

  void app.whenReady().then(() => {
    applySessionHardening();
    registerIpcHandlers({ vault, appVersion: APP_VERSION });

    const window = createMainWindow({
      onLockVault: () => {
        vault.lock();
      },
      onSaveVault: () => {
        // Menu items cannot await, and a failed save must not become an unhandled
        // rejection that takes the process down. The renderer is told either way.
        void vault.save().catch((error: unknown) => {
          console.error('[menu] save failed:', error);
        });
      },
      onOpenPreferences: () => {
        // Wired to the settings route in Phase 14; the accelerator exists now so the
        // shortcut does not have to be re-taught later.
      },
      isVaultUnlocked: () => vault.state === 'unlocked',
    });

    // Only ever active under KEYHOLD_SMOKE=1; see src/main/smoke.ts.
    if (isSmokeRun()) runSmokeCheck(window);

    // macOS convention: clicking the dock icon with no windows open reopens one.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  // Locking on window close is not politeness, it is the point: a window closed with the
  // vault still unlocked would leave the DEK and every decrypted record live in a process
  // the user believes they have finished with.
  app.on('window-all-closed', () => {
    vault.lock();
    // On macOS an app conventionally stays alive with no windows; everywhere else closing
    // the last window means quit. For a password manager quitting is also the safest
    // default, because it guarantees the keys are gone.
    if (process.platform !== 'darwin') app.quit();
  });

  // Last line of defence. `lock()` is idempotent, so it is safe for this to fire after
  // window-all-closed has already run.
  app.on('will-quit', () => {
    vault.lock();
    unregisterIpcHandlers();
  });
}
