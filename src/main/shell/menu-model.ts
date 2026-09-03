// SPDX-License-Identifier: GPL-3.0-or-later
import type { Platform } from '@shared/ipc/api.js';
import type { ThemeMode } from '@shared/theme/appearance.js';
import { MENU_COMMANDS, menuCommand, type MenuCommandId } from './menu-commands.js';

/**
 * The application menu, as a plain data tree.
 *
 * Nothing in this file imports `electron`. That is the point: the two things worth proving
 * about a menu — that every vault-shaped item is disabled while the vault is locked, and
 * that macOS gets a macOS menu rather than a ported Windows one — are proved here, under
 * Vitest, with no Electron process anywhere. `menu-template.ts` turns the tree into
 * `MenuItemConstructorOptions` and does nothing else.
 *
 * ## Why the menu still matters in 2026
 *
 * Three reasons that are easy to dismiss and expensive to lose:
 *
 * - **It is the discoverable list of every keyboard shortcut.** A command palette is faster
 *   once you know a command exists; the menu is how you find out it exists at all.
 * - **It is how screen-reader users navigate an application's commands.** Replacing it with
 *   a custom hamburger removes an entire accessibility route.
 * - **macOS and Windows genuinely differ.** The app menu, the Window menu, and the position
 *   of Settings and Quit are platform conventions, not preferences. A Windows menu shipped
 *   on macOS reads as a port on first glance.
 *
 * ## Edit is built from roles, deliberately
 *
 * Cut/Copy/Paste/Undo are `role` items, never hand-written `click` handlers. A hand-written
 * cut/copy/paste does not talk to the focused text field — it talks to whatever the handler
 * thought was focused — and it breaks native text editing in every input in the app,
 * including the master-password field. Roles route to the focused WebContents the way the
 * platform expects. This is not a shortcut; it is the only correct implementation.
 */

/**
 * The Electron menu roles this app uses.
 *
 * Spelled out rather than imported from `electron`, so this file stays importable without
 * an Electron process. `menu-template.ts` is where the two meet, and the compiler checks
 * the assignment there.
 */
export const MENU_ROLES = [
  'about',
  'services',
  'hide',
  'hideOthers',
  'unhide',
  'quit',
  'close',
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'pasteAndMatchStyle',
  'selectAll',
  'delete',
  'resetZoom',
  'zoomIn',
  'zoomOut',
  'togglefullscreen',
  'toggleDevTools',
  'reload',
  'forceReload',
  'minimize',
  'zoom',
  'front',
  'window',
] as const;

export type MenuRole = (typeof MENU_ROLES)[number];

export type MenuNode =
  | { readonly kind: 'separator' }
  | { readonly kind: 'role'; readonly role: MenuRole; readonly label?: string | undefined }
  | {
      readonly kind: 'command';
      readonly command: MenuCommandId;
      readonly label: string;
      readonly enabled: boolean;
      readonly accelerator?: string | undefined;
    }
  | {
      readonly kind: 'radio';
      readonly command: MenuCommandId;
      readonly label: string;
      readonly enabled: boolean;
      readonly checked: boolean;
    }
  | { readonly kind: 'submenu'; readonly label: string; readonly items: readonly MenuNode[] };

export interface MenuSection {
  readonly label: string;
  /**
   * macOS attaches platform behaviour to two menus by role: `help` gets the search field,
   * `window` gets the automatic window list. Naming a menu "Help" is not enough.
   */
  readonly role?: 'help' | 'windowMenu' | undefined;
  readonly items: readonly MenuNode[];
}

export interface ShellState {
  readonly platform: Platform;
  /** `app.isPackaged`. Devtools and reload exist only when this is false. */
  readonly isPackaged: boolean;
  readonly vaultUnlocked: boolean;
  /**
   * The commands the app can currently actually run.
   *
   * Mirrors `resolveCommands` in the renderer's palette: during a phased build, "no handler
   * exists yet" and "unavailable in this state" are the same fact from the menu's side. A
   * command absent from this set is rendered disabled rather than hidden, because a menu
   * whose items move around between builds is a menu people stop learning.
   */
  readonly availableCommands: ReadonlySet<MenuCommandId>;
  readonly themeMode: ThemeMode;
  readonly appName: string;
}

const isMac = (state: ShellState): boolean => state.platform === 'darwin';

/**
 * Whether a command may be clicked right now.
 *
 * Two independent gates, both of which must pass. The lock gate is the security-relevant
 * one and it is checked against the catalogue rather than against a list kept here, so a
 * new vault command is disabled correctly the moment it is added — the failure mode of a
 * second list is a new command that is *enabled while locked* because nobody remembered to
 * add it to the other copy.
 */
export function isCommandEnabled(state: ShellState, id: MenuCommandId): boolean {
  if (menuCommand(id).needsUnlockedVault && !state.vaultUnlocked) return false;
  return state.availableCommands.has(id);
}

function command(state: ShellState, id: MenuCommandId): MenuNode {
  const definition = menuCommand(id);
  return {
    kind: 'command',
    command: id,
    label: definition.label,
    enabled: isCommandEnabled(state, id),
    accelerator: definition.accelerator,
  };
}

function themeRadio(state: ShellState, id: MenuCommandId, mode: ThemeMode): MenuNode {
  const definition = menuCommand(id);
  return {
    kind: 'radio',
    command: id,
    label: definition.label,
    enabled: isCommandEnabled(state, id),
    // `fixed` means the user is on a custom theme, so none of the three built-in modes is
    // the current one. Checking "Light" underneath a custom dark palette would be a lie the
    // user can see.
    checked: state.themeMode === mode,
  };
}

const separator: MenuNode = { kind: 'separator' };

/**
 * The macOS application menu.
 *
 * Empty on every other platform — this menu does not exist off macOS, and faking it with a
 * "Keyhold" menu on Windows is the single most obvious sign of a port. Settings and Quit
 * live here on macOS and in File on Windows, which is why they are not simply appended to
 * File on both.
 */
function appMenuSection(state: ShellState): readonly MenuSection[] {
  if (!isMac(state)) return [];

  return [
    {
      label: state.appName,
      items: [
        { kind: 'role', role: 'about', label: `About ${state.appName}` },
        separator,
        command(state, 'app.settings'),
        separator,
        { kind: 'role', role: 'services' },
        separator,
        { kind: 'role', role: 'hide' },
        { kind: 'role', role: 'hideOthers' },
        { kind: 'role', role: 'unhide' },
        separator,
        { kind: 'role', role: 'quit' },
      ],
    },
  ];
}

function fileSection(state: ShellState): MenuSection {
  const tail: readonly MenuNode[] = isMac(state)
    ? [{ kind: 'role', role: 'close' }]
    : [
        // Windows keeps Settings and Exit at the bottom of File. Both are platform
        // conventions rather than choices, and both are in the app menu on macOS.
        command(state, 'app.settings'),
        separator,
        { kind: 'role', role: 'quit' },
      ];

  return {
    label: '&File',
    items: [
      command(state, 'vault.new'),
      command(state, 'vault.open'),
      separator,
      command(state, 'vault.save'),
      command(state, 'vault.lock'),
      command(state, 'vault.close'),
      separator,
      command(state, 'vault.import'),
      command(state, 'vault.export'),
      command(state, 'vault.merge'),
      separator,
      ...tail,
    ],
  };
}

/**
 * Edit. Roles only, plus Find.
 *
 * See the file header: a hand-written cut/copy/paste breaks native text editing. `Find…`
 * is a command because it focuses *our* search box rather than invoking a platform service.
 */
function editSection(state: ShellState): MenuSection {
  return {
    label: '&Edit',
    items: [
      { kind: 'role', role: 'undo' },
      { kind: 'role', role: 'redo' },
      separator,
      { kind: 'role', role: 'cut' },
      { kind: 'role', role: 'copy' },
      { kind: 'role', role: 'paste' },
      ...(isMac(state) ? ([{ kind: 'role', role: 'pasteAndMatchStyle' }] as const) : ([] as const)),
      { kind: 'role', role: 'selectAll' },
      separator,
      command(state, 'search.focus'),
    ],
  };
}

function viewSection(state: ShellState): MenuSection {
  // Reload and devtools exist in development only, matching `security.ts` — which also
  // closes devtools on sight in a packaged build. A reload item in a shipped password
  // manager is a way to discard unsaved work with one keystroke and nothing else.
  const developerItems: readonly MenuNode[] = state.isPackaged
    ? []
    : [
        separator,
        { kind: 'role', role: 'reload' },
        { kind: 'role', role: 'forceReload' },
        { kind: 'role', role: 'toggleDevTools' },
      ];

  return {
    label: '&View',
    items: [
      command(state, 'palette.open'),
      command(state, 'view.sidebar'),
      separator,
      {
        kind: 'submenu',
        label: 'Theme',
        items: [
          themeRadio(state, 'view.theme.system', 'system'),
          themeRadio(state, 'view.theme.light', 'light'),
          themeRadio(state, 'view.theme.dark', 'dark'),
        ],
      },
      separator,
      { kind: 'role', role: 'resetZoom' },
      { kind: 'role', role: 'zoomIn' },
      { kind: 'role', role: 'zoomOut' },
      separator,
      { kind: 'role', role: 'togglefullscreen' },
      ...developerItems,
    ],
  };
}

function vaultSection(state: ShellState): MenuSection {
  return {
    label: '&Vault',
    items: [
      command(state, 'credential.new'),
      command(state, 'vault.trash'),
      separator,
      command(state, 'tools.generator'),
      command(state, 'tools.health'),
      command(state, 'tools.activity'),
      ...(isMac(state) ? ([separator, command(state, 'app.settings')] as const) : ([] as const)),
    ],
  };
}

function windowSection(state: ShellState): MenuSection {
  return {
    label: '&Window',
    role: 'windowMenu',
    items: isMac(state)
      ? [
          { kind: 'role', role: 'minimize' },
          { kind: 'role', role: 'zoom' },
          separator,
          { kind: 'role', role: 'front' },
          separator,
          { kind: 'role', role: 'window' },
        ]
      : [
          { kind: 'role', role: 'minimize' },
          { kind: 'role', role: 'zoom' },
          separator,
          { kind: 'role', role: 'close' },
        ],
  };
}

function helpSection(state: ShellState): MenuSection {
  return {
    label: '&Help',
    role: 'help',
    items: [
      command(state, 'help.docs'),
      command(state, 'help.changelog'),
      command(state, 'help.shortcuts'),
      separator,
      command(state, 'help.security'),
      command(state, 'help.reportIssue'),
      // About is in the app menu on macOS and would be a duplicate here.
      ...(isMac(state) ? ([] as const) : ([separator, command(state, 'help.about')] as const)),
    ],
  };
}

/** The whole menu, for a given shell state. Pure. */
export function buildMenuModel(state: ShellState): readonly MenuSection[] {
  return [
    ...appMenuSection(state),
    fileSection(state),
    editSection(state),
    viewSection(state),
    vaultSection(state),
    windowSection(state),
    helpSection(state),
  ];
}

// ── Queries, for the guards and for the template builder ─────────────────────

/** Every node in the tree, submenu contents included. */
export function flattenMenu(sections: readonly MenuSection[]): readonly MenuNode[] {
  const out: MenuNode[] = [];

  const walk = (items: readonly MenuNode[]): void => {
    for (const item of items) {
      out.push(item);
      if (item.kind === 'submenu') walk(item.items);
    }
  };

  for (const section of sections) walk(section.items);
  return out;
}

export interface MenuCommandNode {
  readonly command: MenuCommandId;
  readonly label: string;
  readonly enabled: boolean;
}

/** Every command and radio node, flattened. The unit the guards assert over. */
export function commandNodes(sections: readonly MenuSection[]): readonly MenuCommandNode[] {
  return flattenMenu(sections)
    .filter((node): node is Extract<MenuNode, { kind: 'command' | 'radio' }> => {
      return node.kind === 'command' || node.kind === 'radio';
    })
    .map((node) => ({ command: node.command, label: node.label, enabled: node.enabled }));
}

/** The commands currently clickable. Used by the locked-state guard. */
export function enabledCommandIds(sections: readonly MenuSection[]): ReadonlySet<MenuCommandId> {
  return new Set(
    commandNodes(sections)
      .filter((node) => node.enabled)
      .map((node) => node.command)
  );
}

export interface MenuShortcutBinding {
  readonly shortcutId: string;
  readonly command: MenuCommandId;
  readonly accelerator: string;
}

/**
 * Every accelerator the menu declares that also names a renderer shortcut.
 *
 * Fed to `findShortcutDrift` — see `shortcut-parity.ts`. Commands with no `shortcutId`
 * (Open Vault, Settings) are menu-only bindings with nothing to disagree with, and are
 * deliberately absent rather than reported as unmatched.
 */
export function menuShortcutBindings(): readonly MenuShortcutBinding[] {
  const bindings: MenuShortcutBinding[] = [];

  for (const definition of MENU_COMMANDS) {
    if (definition.shortcutId === undefined || definition.accelerator === undefined) continue;
    bindings.push({
      shortcutId: definition.shortcutId,
      command: definition.id,
      accelerator: definition.accelerator,
    });
  }

  return bindings;
}
