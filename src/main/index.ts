// SPDX-License-Identifier: GPL-3.0-or-later
import { app, BrowserWindow } from 'electron';
import { EVENTS } from '@shared/ipc/api.js';
import { DEFAULT_BREACH_CHECK_SETTINGS } from '@shared/model/breach.js';
import type { KdfProgressView } from '@shared/model/kdf-progress.js';
import type { VaultChangedExternally } from '@shared/model/vault-change.js';
import { BreachService } from './breach/service.js';
import { NetworkPolicy } from './network-policy.js';
import { uuid } from './crypto/random.js';
import { VaultWatcher } from './sync/index.js';
import { notifyThemeFileOpened, openedThemes } from './theme/index.js';
import {
  notifySessionChanged,
  registerIpcHandlers,
  unregisterIpcHandlers,
} from './ipc/register.js';
import { OriginCapture } from './history/origin.js';
import { SystemNetworkProbe } from './history/network-name.js';
import { applySessionHardening, applyWebContentsHardening } from './security.js';
import { isSmokeRun, runSmokeCheck } from './smoke.js';
import { installOpenFileHandler, NativeShell, type MenuCommandId } from './shell/index.js';
import { SessionController } from './session/session-controller.js';
import { mirrorVault, type MirrorResult } from './vault/mirror-backup.js';
import { VaultService } from './vault/vault-service.js';
import { applyContentProtection, createMainWindow, focusMainWindow } from './window.js';

/** Baked in at build time by electron-vite. */
declare const APP_VERSION: string;

/**
 * The single session for this process.
 *
 * One per process, not one per window: two vault services could hold the same file open
 * and race each other's atomic writes, which is the data-loss bug the single-instance lock
 * below also guards against from the other direction.
 */
/**
 * The provenance source for the audit trail.
 *
 * Constructed here rather than inside `VaultService`, because it is the one thing in that
 * class that reads the machine — and a default that reached for the hostname would mean
 * every test, and every embedding that forgot, recorded it.
 */
const originCapture = new OriginCapture({
  appVersion: APP_VERSION,
  probe: new SystemNetworkProbe(),
});

/**
 * One device id, shared by the writer and the watcher.
 *
 * `VaultService` stamps this into every header it writes, and the watcher compares against
 * it to tell our own saves from somebody else's. Two ids would make every save look like an
 * external change — the watcher would prompt on the user's own edits, which is the failure
 * that makes people dismiss the prompt that matters.
 */
const DEVICE_ID = uuid();

const vault = new VaultService(DEVICE_ID, originCapture);
const session = new SessionController(vault);

/**
 * Watching the open vault file.
 *
 * Started on open and stopped on lock, both through the session's own listeners so nothing
 * has to remember. Stopping matters more than it looks: the watch holds a handle on the
 * vault's *directory*, and on Windows that stops the folder being renamed or moved for as
 * long as it is held.
 */
let vaultWatcher: VaultWatcher | null = null;

function stopVaultWatch(): void {
  vaultWatcher?.stop();
  vaultWatcher = null;
  vault.setWriteGuard(null);
}

session.onOpen((vaultPath) => {
  stopVaultWatch();

  const watcher = new VaultWatcher({
    path: vaultPath,
    localDeviceId: DEVICE_ID,
    onExternalChange: (change) => {
      // Reported, never acted on. Reloading or merging is a decision with a mandatory backup
      // attached, and it belongs to whatever asks the user — not to the thing that noticed.
      mainWindow?.webContents.send(EVENTS.vaultChangedExternally, {
        knownGeneration: change.known.generation,
        currentGeneration: change.current.generation,
        differentVault: change.differentVault,
        wentBackwards: change.wentBackwards,
      } satisfies VaultChangedExternally);
    },
  });

  watcher.start();
  vaultWatcher = watcher;

  // Every write, not just `SessionController.save()`. The import service calls
  // `VaultService.save()` directly and `createVault` saves internally, so bracketing at the
  // session layer would have left those unbracketed and looking correct.
  vault.setWriteGuard(() => watcher.beginLocalWrite());
});

/**
 * The off-machine copy, refreshed after every save.
 *
 * Wired here rather than inside `VaultService` because the destination is a **machine**
 * preference and the vault service must not learn about preferences to do a file copy.
 *
 * Deliberately fire-and-forget. The destination is removable, remote or both — unplugged,
 * full, or needing a password nobody typed today — and none of that may delay or fail a save
 * to the vault that is present. The outcome is recorded so the settings screen can say what
 * happened; nothing here throws.
 */
let lastMirror: MirrorResult | null = null;

vault.setAfterSave((vaultPath) => {
  const preferences = session.machineSettings();
  void mirrorVault({
    vaultPath,
    settings: { directory: preferences.mirrorDirectory, keep: preferences.mirrorKeep },
    at: Date.now(),
  }).then((result) => {
    if (result.status !== 'disabled') lastMirror = result;
  });
});

/** What the settings screen reports about the last copy. Read through the IPC layer. */
export function lastMirrorResult(): MirrorResult | null {
  return lastMirror;
}

session.onLock(() => {
  stopVaultWatch();
});

/**
 * The network kill-switch, and the one place a breach client is built.
 *
 * Both switches read through on every question rather than being captured: the machine's
 * `networkAllowed` from `machineSettings()`, and the open vault's `breachCheck` from its
 * settings. Flipping either takes effect at the next question, not the next restart.
 *
 * `settings()` throws when no vault is open, which is the common case at startup and every
 * time the vault is locked. Answered as "off" rather than allowed to throw: no vault means
 * no passwords to check, so there is nothing the check could be permitted to do.
 */
const networkPolicy = new NetworkPolicy({
  networkAllowed: () => session.machineSettings().networkAllowed,
});

const breach = new BreachService({
  policy: networkPolicy,
  // Only so `availability()` can tell "no vault is open" apart from "you have not turned this
  // on". Two different sentences, and two different things for the user to do about them.
  vaultOpen: () => session.vault.state === 'unlocked',
  settings: () => {
    try {
      return session.vault.settings().breachCheck;
    } catch {
      return DEFAULT_BREACH_CHECK_SETTINGS;
    }
  },
});

// The obligation the audit found written in a comment and waiting for a composition root.
// The range cache outlives a sweep on purpose, so it would outlive a lock too — and its keys
// are the 20-bit prefixes of the open vault's passwords, which is a partial fingerprint of
// it. Registered here rather than called from `session.lock()` so nothing has to remember.
session.onLock(() => {
  breach.reset();
});

// The Argon2 estimate, pushed at ~10 Hz while a derivation runs.
//
// Registered here beside the other cross-cutting wiring rather than inside the session, for
// the same reason the lock teardown is: the composition root is the one place that knows both
// that a session exists and that a window does.
session.onKdfProgress((progress) => {
  mainWindow?.webContents.send(EVENTS.kdfProgress, progress satisfies KdfProgressView);
});

/**
 * The shell, once the app is ready. Held at module scope so `before-quit` and `will-quit`
 * can reach it — without `prepareToQuit` a close-to-tray build cannot be quit at all.
 */
let shell: NativeShell | null = null;

/**
 * The main window.
 *
 * At module scope rather than inside `whenReady`, because the menu handler, the tray and
 * the `activate` handler all act on it and all outlive that closure.
 */
let mainWindow: BrowserWindow | null = null;

/**
 * The menu commands this build can actually perform.
 *
 * Deliberately small. Every other command in the catalogue renders **disabled**, which is
 * honest, rather than enabled and silently doing nothing — the failure a user cannot
 * report. It grows as each surface becomes reachable from the main process.
 */
const AVAILABLE_MENU_COMMANDS: ReadonlySet<MenuCommandId> = new Set([
  'vault.save',
  'vault.lock',
  'app.quit',
  'window.show',
  'window.hide',
]);

function runMenuCommand(command: MenuCommandId): void {
  // Not an exhaustive switch, deliberately: the catalogue has twenty-five commands and this
  // build can perform five. Listing the other twenty as empty cases would say nothing that
  // `AVAILABLE_MENU_COMMANDS` does not already say, and would have to be edited twice every
  // time a surface lands. The default below is the honest handler for the rest.
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- see above
  switch (command) {
    case 'vault.lock':
      session.lock('manual');
      notifySessionChanged(mainWindow);
      return;
    case 'vault.save':
      // A menu item cannot await, and a failed save must not become an unhandled rejection
      // that takes the process down. The renderer is told either way.
      void session.save().catch((error: unknown) => {
        console.error('[menu] save failed:', error);
      });
      return;
    case 'app.quit':
      app.quit();
      return;
    default:
      // Everything else belongs to the renderer.
      //
      // Most of the catalogue names something only the UI can do — open a tool view, focus
      // the search box, show the shortcut sheet — and the main process has no business
      // reimplementing any of it. So the command is forwarded, and the renderer routes it
      // through the same registries its own sidebar and palette read.
      //
      // Sent even when the renderer has no handler for it yet. That is the honest split:
      // whether the app can *perform* a command is `AVAILABLE_MENU_COMMANDS`, which decides
      // whether the item is clickable at all, and duplicating that judgement here would be
      // two answers to one question. Reaching this line means the item was enabled, so the
      // command has a home; if the renderer drops it, that is a gap on the renderer's side
      // and one it can log with the context to say something useful about.
      mainWindow?.webContents.send(EVENTS.menuCommand, command);
  }
}

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

  // Before `whenReady`, deliberately: macOS delivers `open-file` for a double-clicked
  // document *before* the app is ready, and Electron only queues it if something is
  // already listening. A handler registered inside `whenReady` misses the launch that
  // started the app.
  installOpenFileHandler({
    platform: process.platform,
    onOpenFile: (request) => {
      // Themes only. A `.keep` or `.keepx` arriving from the OS still needs the vault-open
      // path to accept a path it did not choose, which is its own slice — but the theme
      // extension has been in the accept list since `file-open-request.ts` was written, with
      // nothing on the other end, so double-clicking one did nothing at all.
      if (request.kind !== 'theme') return;
      openedThemes.remember(request.path);
      notifyThemeFileOpened(mainWindow);
    },
  });

  void app.whenReady().then(() => {
    applySessionHardening();
    registerIpcHandlers({
      session,
      appVersion: APP_VERSION,
      originCapture,
      // The only route from a channel to a socket, and it is one object with one method.
      // Everything that decides whether a request may happen — the machine kill-switch, the
      // vault's opt-in, the teardown on lock — is inside this service, so the IPC layer never
      // has to ask and can never accidentally answer.
      breach,
      mirrorStatus: () => {
        const result = lastMirror;
        if (result === null || result.status === 'disabled') return null;
        return {
          status: result.status,
          fileName: result.fileName,
          problem: result.problem,
          at: result.at,
        };
      },
      userDataPath: app.getPath('userData'),
      getWindow: () => mainWindow,
    });

    const window = createMainWindow();
    mainWindow = window;

    // Before the first paint, so a screenshot taken the instant the window appears is already
    // excluded. On by default — see `MachineSettings.blockScreenCapture` for why this one
    // switch runs the other way from the two beside it.
    applyContentProtection(window, session.machineSettings().blockScreenCapture);

    // ── The native shell: menus, tray, and window behaviour ──────────────────
    //
    // Replaces the hand-written menu that used to live in `window.ts`. That was a second
    // copy of the enable/disable rules, and the weaker copy would have been the one in
    // force — the duplicate-list failure hard rule 8 exists to prevent.
    shell = new NativeShell({
      host: {
        appName: app.name,
        platform: process.platform,
        isPackaged: app.isPackaged,
        getWindow: () => mainWindow,
        isVaultUnlocked: () => session.status().state === 'unlocked',
        getThemeMode: () => 'system',
        // Only the commands the app can actually run right now. Everything else renders
        // disabled rather than silently doing nothing, which is the honest failure.
        getAvailableCommands: () => AVAILABLE_MENU_COMMANDS,
        onCommand: (command) => {
          runMenuCommand(command);
        },
        onHiddenToTray: () => {
          // A hidden window fires neither `minimize` nor `blur`, so auto-lock cannot see
          // it. This is the one shell gesture with a security consequence, which is why
          // the shell reports it separately rather than as an ordinary command.
          session.lock('manual');
          notifySessionChanged(mainWindow);
        },
        onPowerEvent: () => {
          // Locking on sleep is `auto-lock.ts`'s job and is deliberately not duplicated
          // here; this only refreshes state that went stale while the machine was asleep.
          notifySessionChanged(mainWindow);
        },
        onOpenFile: (request) => {
          // Themes are handled; a vault or a parcel is still accepted, validated, and not
          // yet acted on — the vault-open path takes a path from a dialog the main process
          // owned, and routing an OS-supplied one through it is its own slice. Deliberately
          // silent about the rest rather than logging a path.
          if (request.kind !== 'theme') return;
          openedThemes.remember(request.path);
          notifyThemeFileOpened(mainWindow);
        },
      },
    });
    shell.start();
    shell.attachWindow(window);
    shell.handleArgv(process.argv);

    // The controller needs the window for window-scoped auto-lock triggers, and needs a
    // way to tell the renderer that an auto-lock happened — otherwise the UI keeps
    // rendering a vault that is no longer open.
    session.attachWindow(window, () => {
      notifySessionChanged(mainWindow);
    });

    // Only ever active under KEYHOLD_SMOKE=1; see src/main/smoke.ts.
    if (isSmokeRun()) runSmokeCheck(window);

    // macOS convention: clicking the dock icon with no windows open reopens one.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length !== 0) return;
      const reopened = createMainWindow();
      mainWindow = reopened;
      applyContentProtection(reopened, session.machineSettings().blockScreenCapture);
      // The shell must follow a recreated window, or the tray and the menu act on a window
      // that no longer exists.
      shell?.attachWindow(reopened);
    });
  });

  // Locking on window close is not politeness, it is the point: a window closed with the
  // vault still unlocked would leave the DEK and every decrypted record live in a process
  // the user believes they have finished with.
  app.on('window-all-closed', () => {
    session.lock('manual');
    // On macOS an app conventionally stays alive with no windows; everywhere else closing
    // the last window means quit. For a password manager quitting is also the safest
    // default, because it guarantees the keys are gone.
    if (process.platform !== 'darwin') app.quit();
  });

  // Last line of defence. `lock()` is idempotent, so it is safe for this to fire after
  // window-all-closed has already run.
  app.on('will-quit', () => {
    session.dispose();
    unregisterIpcHandlers();
  });
}
