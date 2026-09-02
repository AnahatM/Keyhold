// SPDX-License-Identifier: GPL-3.0-or-later
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { HARDENED_WEB_PREFERENCES, hardenWindow } from './security.js';
import { readWindowState, trackWindowState, windowOptionsFromState } from './window-state.js';

/** Below this the three-pane layout collapses to a single pane; smaller is unusable. */
const MIN_WIDTH = 720;
const MIN_HEIGHT = 520;

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function createMainWindow(): BrowserWindow {
  const state = readWindowState();

  const window = new BrowserWindow({
    ...windowOptionsFromState(state),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    // Shown only once the first paint has landed — an empty white flash on a
    // security tool reads as "did it crash?".
    show: false,
    autoHideMenuBar: false,
    backgroundColor: '#12131a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      ...HARDENED_WEB_PREFERENCES,
      preload: join(import.meta.dirname, '../preload/index.cjs'),
    },
  });

  hardenWindow(window);
  trackWindowState(window);

  window.once('ready-to-show', () => {
    // Maximise before showing, so the window does not visibly jump from its restored size
    // to full screen on every launch.
    if (state.maximised) window.maximize();
    window.show();
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  // No window-open handler here, deliberately. `hardenWindow` above already installs one,
  // and `setWindowOpenHandler` keeps a single handler per WebContents — so the copy that
  // used to live here silently replaced the hardened one and dropped its scheme check,
  // meaning `window.open('ms-msdt:…')` reached `shell.openExternal` unfiltered. Two copies
  // of one policy, with the weaker copy in force: exactly what hard rule 8 is about.

  // The dev server is honoured ONLY in development. In a packaged build this would let
  // anyone who can set an environment variable choose what the main window loads — with the
  // preload bridge attached, so scripts from that origin could call `vault.unlock` and
  // `credentials.revealSecret`. Same `!app.isPackaged` idiom as `devTools` in security.ts.
  const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl !== undefined && devServerUrl !== '') {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }

  mainWindow = window;
  return window;
}

/** Brings the existing window forward — used by the single-instance handler. */
export function focusMainWindow(): void {
  if (mainWindow === null) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}
