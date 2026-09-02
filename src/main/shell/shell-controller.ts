// SPDX-License-Identifier: GPL-3.0-or-later
import { statSync } from 'node:fs';
import {
  app,
  nativeImage,
  screen,
  type BrowserWindow,
  type Event as ElectronEvent,
  type NativeImage,
} from 'electron';
import type { Platform } from '@shared/ipc/api.js';
import type { ThemeMode } from '@shared/theme/appearance.js';
import {
  fileOpenRequestsFromArgv,
  parseFileOpenRequest,
  type FileOpenAccepted,
} from './file-open-request.js';
import type { MenuCommandId } from './menu-commands.js';
import { buildMenuModel, type MenuSection, type ShellState } from './menu-model.js';
import { applyMenu } from './menu-template.js';
import { watchPowerEvents, type PowerEvent, type PowerWatchHandle } from './power-events.js';
import { DEFAULT_SHELL_SETTINGS, type ShellSettings } from './shell-settings.js';
import { createTray, type TrayHandle } from './tray.js';
import { isVisibleOnSomeDisplay } from './window-placement.js';

/**
 * The native shell: menu, tray, power events, and files handed to us by the OS.
 *
 * This is the only Electron-bound orchestration in `src/main/shell`. Everything it decides
 * was decided by a pure function it calls — which is why the tests next to those functions
 * are worth something and why there is nothing here that needs a running Electron to
 * reason about.
 *
 * ## What it does not do
 *
 * It **never touches the session**. It has no `SessionController`, cannot lock, cannot save,
 * and cannot read a credential. It reports — "the user chose Lock", "the window was hidden",
 * "the OS handed us this file" — and `src/main/index.ts` decides what that means. That is
 * not politeness about layering: a shell that could reach the vault would be a second path
 * into it, sitting next to the IPC layer that validates everything, and validating nothing.
 *
 * It also creates no `BrowserWindow` and no `WebContents`, so nothing here can weaken
 * `HARDENED_WEB_PREFERENCES` or the CSP in `src/main/security.ts`.
 */

export interface ShellHost {
  readonly appName: string;
  readonly platform: Platform;
  readonly isPackaged: boolean;
  readonly getWindow: () => BrowserWindow | null;
  readonly isVaultUnlocked: () => boolean;
  readonly getThemeMode: () => ThemeMode;
  /** Commands the app can actually run right now. Everything else renders disabled. */
  readonly getAvailableCommands: () => ReadonlySet<MenuCommandId>;
  /** A menu or tray item was chosen. The app decides what it means. */
  readonly onCommand: (command: MenuCommandId) => void;
  /**
   * The window was hidden to the tray.
   *
   * Reported separately from `onCommand` because it is the one shell gesture with a
   * security consequence: a hidden window fires neither `minimize` nor `blur`, so auto-lock
   * cannot see it. See `ShellSettings.lockOnHideToTray`.
   */
  readonly onHiddenToTray: () => void;
  /**
   * A power event happened.
   *
   * Locking on sleep and on screen-lock is `auto-lock.ts`'s job and is not duplicated here —
   * see `power-events.ts`. This exists so the app can refresh state that went stale while
   * it was asleep, chiefly the menu, whose enablement was computed before the vault locked.
   */
  readonly onPowerEvent: (event: PowerEvent) => void;
  /** The OS handed us a `.keep` / `.keepx` / `.keeptheme`, already validated. */
  readonly onOpenFile: (request: FileOpenAccepted) => void;
}

/**
 * Registers the macOS `open-file` handler.
 *
 * Separate from the class, and safe to call before `app.whenReady()`, because that is when
 * it has to happen: macOS delivers `open-file` for a double-clicked document *before* the
 * app is ready, and a handler registered inside `whenReady` misses the launch that started
 * the app. Electron only queues the event if something is already listening.
 *
 * The path is validated before it goes anywhere — see `file-open-request.ts`. This is
 * untrusted input: we did not choose the string, the Finder did, on behalf of whatever
 * produced the file.
 */
export function installOpenFileHandler(options: {
  readonly platform: Platform;
  readonly onOpenFile: (request: FileOpenAccepted) => void;
}): void {
  app.on('open-file', (event, path) => {
    // Claiming the event unconditionally: whether we can open the file or not, macOS should
    // not fall through to another handler for a document with our extension.
    event.preventDefault();

    const result = parseFileOpenRequest(path, {
      platform: options.platform,
      isFile: isRegularFile,
    });

    if (!result.ok) {
      // The reason, never the path. A rejected path can be anything the sender chose, and
      // this line goes to a log that may be pasted into an issue.
      console.warn(`[shell] ignoring open-file request: ${result.reason}`);
      return;
    }

    options.onOpenFile(result);
  });
}

/** True when the path names an existing regular file. A directory is not one. */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    // Missing, unreadable, a broken symlink, or a path the OS refused. All of them mean
    // "there is nothing here to open", and none is worth an error dialog on launch.
    return false;
  }
}

/**
 * Loads the tray icon, or `null` when there is not one.
 *
 * `nativeImage.createFromPath` returns an *empty* image for a missing file rather than
 * throwing, and `new Tray(emptyImage)` produces an invisible click target in the system
 * area — present, clickable, and impossible to find. Returning `null` lets the caller skip
 * the tray entirely, which is the honest outcome.
 */
export function loadTrayIcon(iconPath: string): NativeImage | null {
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return null;

  // The macOS menu bar re-tints template images for light and dark mode. A full-colour icon
  // there is legible in exactly one of the two.
  if (process.platform === 'darwin') image.setTemplateImage(true);
  return image;
}

export interface NativeShellOptions {
  readonly host: ShellHost;
  readonly settings?: ShellSettings | undefined;
  /** Absent means no tray, which is also what a missing icon file means. */
  readonly trayIcon?: NativeImage | null | undefined;
}

export class NativeShell {
  readonly #host: ShellHost;
  #settings: ShellSettings;
  #trayIcon: NativeImage | null;
  #tray: TrayHandle | null = null;
  #stopPowerWatch: PowerWatchHandle | null = null;
  #window: BrowserWindow | null = null;
  #windowListeners: (() => void)[] = [];
  /** Set while we are hiding the window ourselves, so the close handler knows to allow it. */
  #quitting = false;

  constructor(options: NativeShellOptions) {
    this.#host = options.host;
    this.#settings = options.settings ?? DEFAULT_SHELL_SETTINGS;
    this.#trayIcon = options.trayIcon ?? null;
  }

  get settings(): ShellSettings {
    return this.#settings;
  }

  /** The current menu model. Exposed for the smoke test and for debugging, not for mutation. */
  menuModel(): readonly MenuSection[] {
    return buildMenuModel(this.#shellState());
  }

  /**
   * Starts the shell: menu, tray, power watch.
   *
   * Called once, after `app.whenReady()`. Idempotent enough to be called again after
   * `dispose()`, which is what a settings change that toggles the tray off and on does.
   */
  start(): void {
    this.#stopPowerWatch = watchPowerEvents({
      onEvent: (event) => {
        // The shell's own reason to care: after a resume the vault has usually been locked
        // underneath us by auto-lock, and the menu is still drawn for an unlocked one.
        this.refresh();
        this.#host.onPowerEvent(event);
      },
    });

    this.#createTrayIfWanted();
    this.refresh();
  }

  /**
   * Binds the shell to the main window.
   *
   * Kept separate from `start()` because the window can be recreated — on macOS, clicking
   * the dock icon with no windows open makes a new one — and the shell has to follow it
   * rather than hold a dead reference.
   */
  attachWindow(window: BrowserWindow): void {
    this.#detachWindow();
    this.#window = window;

    const onClose = (event: ElectronEvent): void => {
      // `#quitting` is what makes close-to-tray survivable: without it there would be no
      // way to actually close the window, because every close would be intercepted.
      if (!this.#settings.closeToTray || this.#quitting || this.#tray === null) return;
      event.preventDefault();
      this.hideToTray();
    };

    /**
     * Minimise-to-tray, done the way Electron actually permits.
     *
     * `minimize` is emitted **after** the window has already been minimised and its listener
     * is declared as taking no arguments at all — there is no `Event` and therefore nothing
     * to `preventDefault()`. The older cancel-the-minimise idiom does not merely fail to
     * compile here, it does not exist, and reaching for a cast to restore it would produce a
     * `preventDefault` call on `undefined` at runtime.
     *
     * So the window is hidden once it is down, which is what minimise-to-tray means on
     * Windows anyway: the taskbar button goes away and the tray icon is the route back.
     * `showWindow()` restores before it shows, so a window that was minimised and then
     * hidden comes back the right way up rather than as an invisible restored window.
     */
    const onMinimize = (): void => {
      if (!this.#settings.minimiseToTray || this.#tray === null) return;
      this.hideToTray();
    };

    const onVisibilityChange = (): void => {
      this.refresh();
    };

    window.on('close', onClose);
    window.on('minimize', onMinimize);
    window.on('show', onVisibilityChange);
    window.on('hide', onVisibilityChange);
    window.on('closed', onVisibilityChange);

    this.#windowListeners = [
      () => window.off('close', onClose),
      () => window.off('minimize', onMinimize),
      () => window.off('show', onVisibilityChange),
      () => window.off('hide', onVisibilityChange),
      () => window.off('closed', onVisibilityChange),
    ];

    this.refresh();
  }

  /**
   * Allows the next close to actually close.
   *
   * `app.quit()` with close-to-tray on would otherwise be swallowed by the close handler
   * above, and the app would become unquittable from its own menu.
   */
  prepareToQuit(): void {
    this.#quitting = true;
  }

  hideToTray(): void {
    const window = this.#window;
    if (window === null || window.isDestroyed()) return;

    window.hide();
    // Reported after the hide, so a listener that locks the vault is acting on a window
    // that is already out of sight rather than one that is about to be.
    if (this.#settings.lockOnHideToTray) this.#host.onHiddenToTray();
    this.refresh();
  }

  /**
   * Brings the window back.
   *
   * The placement check is re-run here and not only at launch. A window hidden to the tray
   * can sit there for hours; a dock unplugged in the meantime leaves its saved position on
   * a display that no longer exists, and showing it would put it somewhere unreachable —
   * the same failure `window-state.ts` guards at startup, arriving through a door that did
   * not exist before the tray did.
   */
  showWindow(): void {
    const window = this.#window;
    if (window === null || window.isDestroyed()) return;

    if (!isVisibleOnSomeDisplay(window.getNormalBounds(), screen.getAllDisplays())) {
      // Centred is always reachable. Clamping to an edge instead would put the window at
      // coordinates the user never chose, which reads as a bug rather than a recovery.
      window.center();
    }

    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    this.refresh();
  }

  toggleWindow(): void {
    const window = this.#window;
    if (window === null || window.isDestroyed()) return;
    if (window.isVisible() && !window.isMinimized()) {
      this.hideToTray();
    } else {
      this.showWindow();
    }
  }

  /** Rebuilds the menu and the tray for the current state. Call after any state change. */
  refresh(): void {
    const state = this.#shellState();
    applyMenu(this.#window, buildMenuModel(state), (command) => {
      this.#host.onCommand(command);
    });

    this.#tray?.refresh({
      vaultUnlocked: state.vaultUnlocked,
      windowVisible: this.#isWindowVisible(),
      appName: this.#host.appName,
    });
  }

  updateSettings(settings: ShellSettings): void {
    const wantedTray = settings.showTrayIcon;
    this.#settings = settings;

    if (wantedTray && this.#tray === null) this.#createTrayIfWanted();
    if (!wantedTray && this.#tray !== null) {
      this.#tray.destroy();
      this.#tray = null;
    }

    this.refresh();
  }

  /**
   * Files named on a command line — this process's own, or a second launch's.
   *
   * The single-instance lock hands the second process's `argv` to the first (see
   * `src/main/index.ts`), which means this string array originated in a *different process*
   * that we know nothing about. Every entry goes through the same validation as a
   * double-clicked file.
   */
  handleArgv(argv: readonly string[]): readonly FileOpenAccepted[] {
    const requests = fileOpenRequestsFromArgv(argv, {
      platform: this.#host.platform,
      isFile: isRegularFile,
      // Packaged: argv[0] is the app. Development: argv[0] is Electron and argv[1] is the
      // script it was pointed at. Neither is a document.
      skipCount: this.#host.isPackaged ? 1 : 2,
    });

    for (const request of requests) this.#host.onOpenFile(request);
    return requests;
  }

  dispose(): void {
    this.#stopPowerWatch?.();
    this.#stopPowerWatch = null;
    this.#tray?.destroy();
    this.#tray = null;
    this.#detachWindow();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  #shellState(): ShellState {
    return {
      platform: this.#host.platform,
      isPackaged: this.#host.isPackaged,
      vaultUnlocked: this.#host.isVaultUnlocked(),
      availableCommands: this.#host.getAvailableCommands(),
      themeMode: this.#host.getThemeMode(),
      appName: this.#host.appName,
    };
  }

  #isWindowVisible(): boolean {
    const window = this.#window;
    return window !== null && !window.isDestroyed() && window.isVisible();
  }

  #createTrayIfWanted(): void {
    if (!this.#settings.showTrayIcon) return;

    const icon = this.#trayIcon;
    if (icon === null) {
      // Not fatal, and not silent. A tray the user enabled and cannot see is worse than a
      // missing feature, and this is a packaging problem rather than a runtime one.
      console.warn('[shell] no tray icon available; the tray will not be created');
      return;
    }

    this.#tray = createTray({
      icon,
      appName: this.#host.appName,
      onCommand: (command) => {
        this.#host.onCommand(command);
      },
      onActivate: () => {
        this.toggleWindow();
      },
    });
  }

  #detachWindow(): void {
    for (const off of this.#windowListeners) off();
    this.#windowListeners = [];
    this.#window = null;
  }
}
