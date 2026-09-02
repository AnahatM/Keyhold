// SPDX-License-Identifier: GPL-3.0-or-later
import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

/**
 * The native application menu.
 *
 * Worth building properly rather than hiding, for three reasons that are easy to miss:
 *
 *  - **It is the discoverable list of every keyboard shortcut.** A command palette is
 *    faster once you know a command exists; the menu is how you find out it exists.
 *  - **It is what screen-reader users navigate the app's commands with.** Hiding it in
 *    favour of a custom hamburger removes an entire accessibility route.
 *  - **macOS and Windows genuinely differ**, and a menu that is a Windows menu on macOS
 *    reads as a port. The app menu, Window menu, and the position of Preferences and Quit
 *    are all platform conventions, not preferences.
 *
 * Every destructive or vault-affecting item is disabled while the vault is locked, rather
 * than being present and failing — a menu item that does nothing is worse than one that
 * is visibly unavailable.
 */

export interface MenuActions {
  readonly onLockVault: () => void;
  readonly onSaveVault: () => void;
  readonly onOpenPreferences: () => void;
  readonly isVaultUnlocked: () => boolean;
}

const isMac = process.platform === 'darwin';

export function buildMenu(window: BrowserWindow, actions: MenuActions): Menu {
  const unlocked = actions.isVaultUnlocked();

  const macAppMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            // On macOS Preferences belongs in the app menu under Cmd+,. Putting it in a
            // File or Edit menu is one of the clearest signs of a straight Windows port.
            {
              label: 'Settings…',
              accelerator: 'Cmd+,',
              click: actions.onOpenPreferences,
            },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
      ]
    : [];

  const template: MenuItemConstructorOptions[] = [
    ...macAppMenu,
    {
      label: '&File',
      submenu: [
        { label: 'New Vault…', accelerator: 'CmdOrCtrl+Shift+N', enabled: false },
        { label: 'Open Vault…', accelerator: 'CmdOrCtrl+O', enabled: false },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          enabled: unlocked,
          click: actions.onSaveVault,
        },
        {
          label: 'Lock Vault',
          accelerator: 'CmdOrCtrl+L',
          enabled: unlocked,
          click: actions.onLockVault,
        },
        { type: 'separator' },
        { label: 'Import…', enabled: false },
        { label: 'Export…', enabled: unlocked },
        { type: 'separator' },
        ...(isMac
          ? [{ role: 'close' } as MenuItemConstructorOptions]
          : [
              {
                label: 'Settings…',
                accelerator: 'Ctrl+,',
                click: actions.onOpenPreferences,
              } as MenuItemConstructorOptions,
              { type: 'separator' } as MenuItemConstructorOptions,
              { role: 'quit' } as MenuItemConstructorOptions,
            ]),
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // Devtools stay reachable in development and disappear entirely once packaged —
        // see src/main/security.ts, which also closes them if they are opened another way.
        ...(app.isPackaged
          ? []
          : [{ type: 'separator' } as const, { role: 'toggleDevTools' } as const]),
      ],
    },
    {
      label: '&Window',
      submenu: isMac
        ? [
            { role: 'minimize' },
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'front' },
            { type: 'separator' },
            { role: 'window' },
          ]
        : [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'close' }],
    },
    {
      label: '&Help',
      role: 'help',
      submenu: [
        { label: 'Keyhold Help', enabled: false },
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', enabled: false },
        { type: 'separator' },
        {
          label: 'Security & Threat Model',
          click: () => {
            void shell.openExternal(
              'https://github.com/AnahatM/Keyhold/blob/main/docs/00-Overview/03-Threat-Model.md'
            );
          },
        },
        {
          label: 'Report an Issue',
          click: () => {
            void shell.openExternal('https://github.com/AnahatM/Keyhold/issues');
          },
        },
        ...(isMac ? [] : [{ type: 'separator' } as const, { role: 'about' } as const]),
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  // On macOS the menu belongs to the application; everywhere else it belongs to the
  // window, and setting it per-window is what lets it reflect the vault's lock state.
  if (isMac) {
    Menu.setApplicationMenu(menu);
  } else {
    window.setMenu(menu);
  }
  return menu;
}
