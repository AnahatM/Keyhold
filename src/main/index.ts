// SPDX-License-Identifier: GPL-3.0-or-later
import { app, BrowserWindow } from 'electron';
import { applySessionHardening, applyWebContentsHardening } from './security.js';
import { createMainWindow, focusMainWindow } from './window.js';
import { isSmokeRun, runSmokeCheck } from './smoke.js';

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
    const window = createMainWindow();

    // Only ever active under KEYHOLD_SMOKE=1; see src/main/smoke.ts.
    if (isSmokeRun()) runSmokeCheck(window);

    // macOS convention: clicking the dock icon with no windows open reopens one.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  // On macOS an app conventionally stays alive with no windows; everywhere else
  // closing the last window means quit. For a password manager, quitting is also
  // the safest default because it guarantees keys are gone from memory.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
