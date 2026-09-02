// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The native shell — application menu, tray, power events, and OS-supplied files.
 *
 * One entry point so `src/main/index.ts` imports a shell rather than six files, and so the
 * split between the pure layer and the Electron layer is stated once, here, where someone
 * arriving at the directory will read it:
 *
 * | Pure — testable under Vitest, no Electron | Electron-bound         |
 * | ----------------------------------------- | ---------------------- |
 * | `menu-commands.ts` — the command catalogue | `menu-template.ts`     |
 * | `menu-model.ts` — the menu tree + enablement | `tray.ts`            |
 * | `tray-model.ts` — the tray menu + its guard | `power-events.ts`      |
 * | `file-open-request.ts` — path validation    | `shell-controller.ts`  |
 * | `window-placement.ts` — off-screen fallback |                        |
 * | `shortcut-parity.ts` — menu vs renderer     |                        |
 * | `shell-settings.ts` — settings + coercion   |                        |
 *
 * Every decision is on the left. The right-hand column translates and wires, and holds no
 * logic that a test would have anything to say about.
 */

export {
  MENU_COMMANDS,
  MENU_COMMAND_IDS,
  MENU_COMMAND_BY_ID,
  credentialExposingCommandIds,
  menuCommand,
  vaultCommandIds,
  type MenuCommand,
  type MenuCommandId,
} from './menu-commands.js';

export {
  buildMenuModel,
  commandNodes,
  enabledCommandIds,
  flattenMenu,
  isCommandEnabled,
  menuShortcutBindings,
  type MenuNode,
  type MenuSection,
  type MenuShortcutBinding,
  type ShellState,
} from './menu-model.js';

export { applyMenu, toMenuTemplate, type MenuDispatch } from './menu-template.js';

export {
  TRAY_COMMANDS,
  buildTrayModel,
  findTrayViolations,
  trayForbiddenCommandIds,
  trayTooltips,
  type TrayItem,
  type TrayModel,
  type TrayState,
  type TrayViolation,
} from './tray-model.js';

export { createTray, type TrayHandle, type TrayOptions } from './tray.js';

export {
  FILE_OPEN_EXTENSIONS,
  fileOpenRequestsFromArgv,
  parseFileOpenRequest,
  type FileOpenAccepted,
  type FileOpenKind,
  type FileOpenRejection,
  type FileOpenResult,
} from './file-open-request.js';

export {
  MIN_VISIBLE_PX,
  chooseWindowPlacement,
  isVisibleOnSomeDisplay,
  type DisplayLike,
  type Rect,
  type SavedPlacement,
  type WindowPlacement,
} from './window-placement.js';

export {
  acceleratorFromCombo,
  findShortcutDrift,
  type AcceleratorCombo,
  type RendererShortcut,
  type ShortcutDrift,
} from './shortcut-parity.js';

export {
  DEFAULT_SHELL_SETTINGS,
  coerceShellSettings,
  type ShellSettings,
} from './shell-settings.js';

export { watchPowerEvents, type PowerEvent, type PowerWatchHandle } from './power-events.js';

export {
  NativeShell,
  installOpenFileHandler,
  isRegularFile,
  loadTrayIcon,
  type NativeShellOptions,
  type ShellHost,
} from './shell-controller.js';
