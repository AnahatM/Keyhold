// SPDX-License-Identifier: GPL-3.0-or-later
import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommandId } from './menu-commands.js';
import type { MenuNode, MenuSection } from './menu-model.js';

/**
 * The Electron half of the menu, and deliberately the *only* Electron half.
 *
 * Everything interesting — what the menu contains, what is disabled, how the platforms
 * differ — happened in `menu-model.ts`, under test, with no Electron process. What is left
 * here is a translation with no decisions in it, which is exactly how much untestable code
 * a menu is allowed to have.
 *
 * Nothing in this file creates a `BrowserWindow` or a `WebContents`, so nothing here can
 * weaken `HARDENED_WEB_PREFERENCES` or the CSP in `src/main/security.ts`.
 */

/** What a menu click does. Supplied by the shell controller, never decided here. */
export type MenuDispatch = (command: MenuCommandId) => void;

function toItem(node: MenuNode, dispatch: MenuDispatch): MenuItemConstructorOptions {
  switch (node.kind) {
    case 'separator':
      return { type: 'separator' };

    case 'role':
      // This assignment is the one place our spelled-out `MenuRole` meets Electron's own
      // role union, and it is checked rather than cast — a role we invented fails to
      // compile here instead of producing a silently dead menu item at runtime.
      return node.label === undefined
        ? { role: node.role }
        : { role: node.role, label: node.label };

    case 'command':
      return {
        label: node.label,
        enabled: node.enabled,
        // Built conditionally rather than passing `undefined`: `exactOptionalPropertyTypes`
        // treats a present-but-undefined property as different from an absent one.
        ...(node.accelerator === undefined ? {} : { accelerator: node.accelerator }),
        click: () => {
          dispatch(node.command);
        },
      };

    case 'radio':
      return {
        type: 'radio',
        label: node.label,
        enabled: node.enabled,
        checked: node.checked,
        click: () => {
          dispatch(node.command);
        },
      };

    case 'submenu':
      return {
        label: node.label,
        submenu: node.items.map((child) => toItem(child, dispatch)),
      };
  }
}

/** The model as an Electron template. Pure apart from the closures it builds. */
export function toMenuTemplate(
  sections: readonly MenuSection[],
  dispatch: MenuDispatch
): MenuItemConstructorOptions[] {
  return sections.map((section) => ({
    label: section.label,
    ...(section.role === undefined ? {} : { role: section.role }),
    submenu: section.items.map((node) => toItem(node, dispatch)),
  }));
}

/**
 * Installs the menu.
 *
 * On macOS the menu belongs to the *application* and there is exactly one; everywhere else
 * it belongs to the window, and setting it per-window is what lets it reflect the lock
 * state of the vault that window is showing. Calling `setApplicationMenu` on Windows would
 * work and would then quietly stop working the day a second window exists.
 */
export function applyMenu(
  window: BrowserWindow | null,
  sections: readonly MenuSection[],
  dispatch: MenuDispatch
): Menu {
  const menu = Menu.buildFromTemplate(toMenuTemplate(sections, dispatch));

  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(menu);
  } else if (window !== null && !window.isDestroyed()) {
    window.setMenu(menu);
  }

  return menu;
}
