// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Platform } from '@shared/ipc/api.js';
import type { ThemeMode } from '@shared/theme/appearance.js';
import { MENU_COMMAND_IDS, menuCommand, type MenuCommandId } from './menu-commands.js';
import {
  buildMenuModel,
  commandNodes,
  enabledCommandIds,
  flattenMenu,
  menuShortcutBindings,
  type MenuNode,
  type MenuSection,
  type ShellState,
} from './menu-model.js';
import { TRAY_COMMANDS } from './tray-model.js';

/**
 * The menu is data, so these are ordinary assertions over a tree — no Electron, no window,
 * no `Menu.buildFromTemplate`. That is the entire reason `menu-model.ts` exists separately
 * from `menu-template.ts`.
 *
 * The security-relevant test is the first one. Everything else is about the menu being a
 * native menu rather than a ported one, which matters but is not a vulnerability.
 */

const ALL_COMMANDS: ReadonlySet<MenuCommandId> = new Set(MENU_COMMAND_IDS);

function state(overrides: Partial<ShellState> = {}): ShellState {
  return {
    platform: 'win32',
    isPackaged: true,
    vaultUnlocked: true,
    availableCommands: ALL_COMMANDS,
    themeMode: 'system',
    appName: 'Keyhold',
    ...overrides,
  };
}

function section(sections: readonly MenuSection[], label: string): MenuSection {
  const found = sections.find((entry) => entry.label === label);
  if (found === undefined) throw new Error(`No menu section labelled "${label}"`);
  return found;
}

function roles(items: readonly MenuNode[]): readonly string[] {
  return items
    .filter((node): node is Extract<MenuNode, { kind: 'role' }> => node.kind === 'role')
    .map((node) => node.role);
}

describe('the locked-vault guard', () => {
  /**
   * The one that matters.
   *
   * A menu item that reaches the vault while the vault is locked is either a broken item or
   * a hole, and which of the two it is depends on code somewhere else. Disabling is the
   * only answer that is correct in both readings.
   *
   * Asserted against the catalogue rather than a list written here: a list here would be a
   * second list, and it would go stale the first time a vault command was added — which is
   * precisely the moment the guard is supposed to fire.
   */
  it('disables every command that needs an unlocked vault', () => {
    const sections = buildMenuModel(state({ vaultUnlocked: false }));
    const enabled = enabledCommandIds(sections);

    const wronglyEnabled = [...enabled].filter((id) => menuCommand(id).needsUnlockedVault);

    expect(wronglyEnabled).toEqual([]);
  });

  it('re-enables them once the vault is open', () => {
    const sections = buildMenuModel(state({ vaultUnlocked: true }));
    const enabled = enabledCommandIds(sections);

    const vaultCommands = commandNodes(sections)
      .map((node) => node.command)
      .filter((id) => menuCommand(id).needsUnlockedVault);

    expect(vaultCommands.length).toBeGreaterThan(0);
    for (const id of vaultCommands) expect(enabled.has(id)).toBe(true);
  });

  it('leaves the lock-independent commands alone while locked', () => {
    const sections = buildMenuModel(state({ vaultUnlocked: false }));
    const enabled = enabledCommandIds(sections);

    // Opening a vault and reading the shortcut sheet are exactly what a locked user needs.
    expect(enabled.has('vault.open')).toBe(true);
    expect(enabled.has('help.shortcuts')).toBe(true);
  });

  it('disables a command the app cannot currently run, even with the vault open', () => {
    const available = new Set(ALL_COMMANDS);
    available.delete('vault.export');

    const enabled = enabledCommandIds(
      buildMenuModel(state({ vaultUnlocked: true, availableCommands: available }))
    );

    expect(enabled.has('vault.export')).toBe(false);
    expect(enabled.has('vault.import')).toBe(true);
  });
});

describe('platform conventions', () => {
  it('gives macOS an application menu as the first menu', () => {
    const sections = buildMenuModel(state({ platform: 'darwin' }));
    const first = sections[0];

    expect(first?.label).toBe('Keyhold');
    // The four that make it an app menu rather than a menu that happens to be first.
    expect(roles(first?.items ?? [])).toEqual(
      expect.arrayContaining(['about', 'services', 'hide', 'quit'])
    );
  });

  it('gives Windows File as the first menu, with no app menu at all', () => {
    const sections = buildMenuModel(state({ platform: 'win32' }));

    expect(sections[0]?.label).toBe('&File');
    expect(sections.some((entry) => entry.label === 'Keyhold')).toBe(false);
  });

  it('puts Settings in the app menu on macOS and in File on Windows', () => {
    const mac = buildMenuModel(state({ platform: 'darwin' }));
    const windows = buildMenuModel(state({ platform: 'win32' }));

    const inMacAppMenu = commandNodes([section(mac, 'Keyhold')]).map((node) => node.command);
    const inMacFile = commandNodes([section(mac, '&File')]).map((node) => node.command);
    const inWindowsFile = commandNodes([section(windows, '&File')]).map((node) => node.command);

    expect(inMacAppMenu).toContain('app.settings');
    expect(inMacFile).not.toContain('app.settings');
    expect(inWindowsFile).toContain('app.settings');
  });

  it('puts Quit in the app menu on macOS and in File on Windows', () => {
    const mac = buildMenuModel(state({ platform: 'darwin' }));
    const windows = buildMenuModel(state({ platform: 'win32' }));

    expect(roles(section(mac, 'Keyhold').items)).toContain('quit');
    expect(roles(section(mac, '&File').items)).not.toContain('quit');
    expect(roles(section(windows, '&File').items)).toContain('quit');
  });

  it('marks the Help and Window menus with their platform roles', () => {
    const sections = buildMenuModel(state({ platform: 'darwin' }));

    // Naming a menu "Help" is not enough — macOS attaches its search field to the role.
    expect(section(sections, '&Help').role).toBe('help');
    expect(section(sections, '&Window').role).toBe('windowMenu');
  });
});

describe('Edit is built from roles', () => {
  /**
   * A hand-written cut/copy/paste does not talk to the focused text field; it talks to
   * whatever the handler assumed was focused. Getting this wrong breaks native editing in
   * every input in the app, the master-password field included, and it breaks it in a way
   * that looks like "the app is a bit janky" rather than like a bug with a cause.
   */
  it('uses roles for the clipboard items, never click handlers', () => {
    const sections = buildMenuModel(state());
    const edit = section(sections, '&Edit');

    expect(roles(edit.items)).toEqual(
      expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
    );

    // No command node in Edit may be one of the clipboard verbs.
    const labels = commandNodes([edit]).map((node) => node.label.toLowerCase());
    for (const verb of ['cut', 'copy', 'paste', 'undo', 'redo', 'select all']) {
      expect(labels).not.toContain(verb);
    }
  });
});

describe('developer items', () => {
  it('are absent from a packaged build', () => {
    const sections = buildMenuModel(state({ isPackaged: true }));
    const all = roles(flattenMenu(sections));

    expect(all).not.toContain('toggleDevTools');
    expect(all).not.toContain('reload');
    expect(all).not.toContain('forceReload');
  });

  it('are present in development', () => {
    const sections = buildMenuModel(state({ isPackaged: false }));
    const all = roles(flattenMenu(sections));

    expect(all).toContain('toggleDevTools');
    expect(all).toContain('reload');
  });
});

describe('the theme submenu', () => {
  const checkedThemes = (mode: ThemeMode): readonly MenuCommandId[] =>
    flattenMenu(buildMenuModel(state({ themeMode: mode })))
      .filter((node): node is Extract<MenuNode, { kind: 'radio' }> => node.kind === 'radio')
      .filter((node) => node.checked)
      .map((node) => node.command);

  it('checks exactly the active mode', () => {
    expect(checkedThemes('light')).toEqual(['view.theme.light']);
    expect(checkedThemes('dark')).toEqual(['view.theme.dark']);
    expect(checkedThemes('system')).toEqual(['view.theme.system']);
  });

  it('checks nothing when a custom theme is active', () => {
    // `fixed` means a user palette, which is none of the three built-in modes. Checking
    // "Light" underneath a custom dark palette is a lie the user can see.
    expect(checkedThemes('fixed')).toEqual([]);
  });
});

describe('the catalogue and the menu agree', () => {
  /**
   * Every command must be reachable from somewhere.
   *
   * An orphan is not harmless: it is a command with a shortcut, a label and a security
   * classification that no surface renders, which is how a table and the thing it describes
   * quietly stop being about each other.
   */
  it('renders every catalogue command in the menu or the tray', () => {
    const platforms: readonly Platform[] = ['darwin', 'win32'];
    const rendered = new Set<MenuCommandId>(TRAY_COMMANDS);

    for (const platform of platforms) {
      for (const id of commandNodes(buildMenuModel(state({ platform })))) {
        rendered.add(id.command);
      }
    }

    const orphans = MENU_COMMAND_IDS.filter((id) => !rendered.has(id));
    expect(orphans).toEqual([]);
  });

  it('exposes an accelerator binding for every command that names a shortcut', () => {
    const bindings = menuShortcutBindings();
    const named = MENU_COMMAND_IDS.filter((id) => menuCommand(id).shortcutId !== undefined);

    expect(bindings.map((binding) => binding.command).sort()).toEqual([...named].sort());
    for (const binding of bindings) expect(binding.accelerator).not.toBe('');
  });
});
