// SPDX-License-Identifier: GPL-3.0-or-later
import { Menu, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import type { MenuCommandId } from './menu-commands.js';
import { buildTrayModel, findTrayViolations, type TrayState } from './tray-model.js';

/**
 * The tray / menu-bar item.
 *
 * The security argument for what is and is not in here lives in `tray-model.ts` and is the
 * important half of this feature. This file only renders that model and owns the Electron
 * object's lifetime.
 *
 * Two runtime details worth stating:
 *
 * - **The guard runs in development, on every rebuild.** A violation is a programming error
 *   that the test suite already fails on, but a tray menu is also the one surface a
 *   half-finished refactor can ship to a user without anyone clicking it. Rendering nothing
 *   is strictly safer than rendering a menu that leaks, so a violation empties the menu
 *   rather than degrading to "probably fine".
 * - **The tray is created once and updated in place.** Destroying and recreating a `Tray`
 *   makes the icon visibly flicker out of and back into the system area on every lock and
 *   unlock, and on Windows it moves the icon to the end of the overflow area each time.
 */

export interface TrayOptions {
  /**
   * The icon. Injected rather than read from a path here, so this file has no opinion about
   * where build resources live and so a missing icon is the caller's decision to make.
   *
   * On macOS this should be a template image — the menu bar re-tints it for light and dark,
   * and a full-colour icon there looks like a bug on one of the two.
   */
  readonly icon: NativeImage;
  readonly appName: string;
  readonly onCommand: (command: MenuCommandId) => void;
  /** Left-clicking the icon. Windows convention; on macOS the click opens the menu. */
  readonly onActivate: () => void;
}

export interface TrayHandle {
  /** Rebuilds the menu and tooltip for a new state. Cheap; call it on every state change. */
  readonly refresh: (state: TrayState) => void;
  readonly destroy: () => void;
}

export function createTray(options: TrayOptions): TrayHandle {
  const tray = new Tray(options.icon);

  // macOS fires both `click` and `double-click` for a double click. Without this a quick
  // double click on a "Show" tray icon shows and then immediately hides the window.
  tray.setIgnoreDoubleClickEvents(true);

  tray.on('click', () => {
    options.onActivate();
  });

  const refresh = (state: TrayState): void => {
    const model = buildTrayModel(state);
    const violations = findTrayViolations(model, options.appName);

    if (violations.length > 0) {
      // Deliberately loud and deliberately empty. See the file header: an empty tray menu is
      // a bug report; a tray menu with a credential action in it is an incident.
      for (const violation of violations) {
        console.error(`[tray] refusing to render: ${violation.kind} — ${violation.detail}`);
      }
      tray.setContextMenu(Menu.buildFromTemplate([]));
      tray.setToolTip(options.appName);
      return;
    }

    const template: MenuItemConstructorOptions[] = model.items.map((item) => ({
      label: item.label,
      enabled: item.enabled,
      click: () => {
        options.onCommand(item.command);
      },
    }));

    tray.setContextMenu(Menu.buildFromTemplate(template));
    tray.setToolTip(model.tooltip);
  };

  return {
    refresh,
    destroy: () => {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
