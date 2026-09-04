// SPDX-License-Identifier: GPL-3.0-or-later
import { join } from 'node:path';
import { app, BrowserWindow, nativeTheme } from 'electron';
import {
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  FALLBACK_THEME,
  findTheme,
} from '@shared/theme/themes.js';
import { HARDENED_WEB_PREFERENCES, hardenWindow } from './security.js';
import { readWindowState, trackWindowState, windowOptionsFromState } from './window-state.js';

/** Below this the three-pane layout collapses to a single pane; smaller is unusable. */
const MIN_WIDTH = 720;
const MIN_HEIGHT = 520;

/**
 * The colour painted before the renderer's first paint.
 *
 * This used to be the literal `#12131a`, which was wrong twice over. It was the one
 * hardcoded colour in a codebase whose stated hard rule is that every colour is a
 * `--kh-color-*` token — and neither guard test could see it, because both operate over the
 * theme definitions and a `BrowserWindow` option is not one. And because it was a fixed dark
 * value, every launch on a light theme opened with a dark flash.
 *
 * Now it is the `bg` token of a real theme, chosen by the OS appearance the same way the
 * renderer chooses its default. It is not the *user's* chosen theme — that lives in the
 * renderer's own storage and is not readable here — so someone running Midnight on a light
 * OS still gets one light frame. That is a strictly smaller mismatch than the previous
 * always-dark behaviour, and closing it entirely means moving the appearance preference into
 * the main process, which is a bigger change than this defect warrants.
 */
function initialBackgroundColour(): string {
  const id = nativeTheme.shouldUseDarkColors ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID;
  return (findTheme(id) ?? FALLBACK_THEME).palette.bg;
}

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * The size the smoke run always gets, whatever the host display is.
 *
 * Comfortably above `AppShell`'s 900px narrow breakpoint, so the three-pane layout is the one
 * being exercised. Without this the run inherits the saved state clamped to the screen, and a
 * CI runner with a 1024-wide virtual display drops the app into narrow mode — where the detail
 * pane is shown only when a record is selected. Four checks then fail on a machine nobody can
 * look at, for a reason nothing in the output mentions.
 *
 * Position is left to Electron. Only the width matters here, and pinning coordinates as well
 * would break on a runner whose display is smaller than the window.
 */
const SMOKE_WINDOW = { width: 1400, height: 900 } as const;

/**
 * Asks the OS to keep the window out of screenshots and screen recordings.
 *
 * `WDA_EXCLUDEFROMCAPTURE` on Windows, `NSWindowSharingNone` on macOS. It is a real
 * OS-enforced exclusion rather than a watermark — a capture gets a black rectangle — but it
 * is the **OS's** promise, not Keyhold's: a camera pointed at the screen still works, and on
 * Linux neither X11 nor Wayland has an equivalent, so Electron accepts the call and nothing
 * happens. The setting's own copy says so rather than letting somebody infer a guarantee.
 *
 * Exported so the settings handler can apply a change to the window that is already open. A
 * protection that needed a restart is one people turn on and then assume is working.
 */
export function applyContentProtection(window: BrowserWindow | null, enabled: boolean): void {
  if (window === null || window.isDestroyed()) return;
  window.setContentProtection(enabled);
}

export function createMainWindow(): BrowserWindow {
  const state = readWindowState();

  const window = new BrowserWindow({
    ...windowOptionsFromState(state),
    // A gate whose result depends on the host's screen resolution is not a gate.
    ...(process.env.KEYHOLD_SMOKE === '1' ? SMOKE_WINDOW : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    // Shown only once the first paint has landed — an empty white flash on a
    // security tool reads as "did it crash?".
    show: false,
    autoHideMenuBar: false,
    backgroundColor: initialBackgroundColour(),
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
