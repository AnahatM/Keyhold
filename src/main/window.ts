// SPDX-License-Identifier: GPL-3.0-or-later
import { join } from 'node:path';
import { BrowserWindow, shell } from 'electron';
import { buildMenu, type MenuActions } from './menu.js';
import { HARDENED_WEB_PREFERENCES, hardenWindow } from './security.js';
import { readWindowState, trackWindowState, windowOptionsFromState } from './window-state.js';

/** Below this the three-pane layout collapses to a single pane; smaller is unusable. */
const MIN_WIDTH = 720;
const MIN_HEIGHT = 520;

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function createMainWindow(menuActions?: MenuActions): BrowserWindow {
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
  if (menuActions !== undefined) buildMenu(window, menuActions);

  window.once('ready-to-show', () => {
    // Maximise before showing, so the window does not visibly jump from its restored size
    // to full screen on every launch.
    if (state.maximised) window.maximize();
    window.show();
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  // Anchor links inside the app open in the user's real browser, never in-app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
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
