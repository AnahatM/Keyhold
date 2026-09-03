// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The command catalogue — every action the native shell can invoke, as data.
 *
 * One table, read by three things that would otherwise each keep their own copy: the
 * application menu, the tray menu, and the guard tests. Hard rule 8. A tray item written
 * by hand somewhere else is exactly the kind of second list that lets a "Copy password"
 * entry appear in a menu that is visible to anyone standing at the machine.
 *
 * ## Why a catalogue rather than `Menu.buildFromTemplate` calls
 *
 * Electron cannot be instantiated under Vitest. A menu assembled by calling into
 * `Menu`/`MenuItem` inside an `app.whenReady()` callback is therefore untestable, and the
 * two properties that actually matter here — *nothing vault-shaped is clickable while the
 * vault is locked* and *nothing in the tray touches a credential* — are precisely the ones
 * that need a test. So the structure and the enable/disable logic are plain data over pure
 * functions (this file and `menu-model.ts`), and the thin `buildFromTemplate` call lives on
 * its own in `menu-template.ts` where there is nothing left to get wrong.
 *
 * ## The two security fields
 *
 * **`needsUnlockedVault`** drives enablement. A greyed-out Export is honest; an Export that
 * is clickable and silently fails teaches the user that the app is broken.
 *
 * **`exposesCredentialData`** is the tray restriction, made structural. A tray menu is not
 * behind the lock — it is one right-click away for anyone at the keyboard, with no master
 * password in between. `tray-model.ts` refuses to place any command carrying this flag, and
 * `tray-model.test.ts` fails the build if one gets through. Adding "Copy password" to the
 * tray therefore requires deliberately mis-declaring it, which is a reviewable act rather
 * than an oversight.
 *
 * ## Accelerators and the renderer's shortcut table
 *
 * Accelerators are written here in Electron's spelling because the main process cannot
 * import from `src/renderer` — the two halves of the app are separate TypeScript programs
 * and that boundary is deliberate. That leaves one string in two places, which is the thing
 * hard rule 8 exists to stop, so it is covered the other way: `shortcut-parity.ts` compares
 * this table against the renderer's registry entry by entry, and the wiring in
 * `docs`/the report turns that into a build-failing guard. A menu that claims Ctrl+S while
 * the renderer binds Ctrl+Shift+S is a bug the user finds before we do.
 */

/** The renderer's `ShortcutId` spellings, as plain strings. See the file header. */
export type ShortcutIdRef = string;

/**
 * The names, re-exported from `@shared/model/menu-commands.ts`.
 *
 * They moved there because the **preload** needs them: a menu click has to reach the
 * renderer, and the bridge must be able to refuse a payload that is not one of these before
 * forwarding it. The preload cannot import from `src/main`, so the alternative was the
 * preload keeping its own copy of twenty-six strings — rule 8's second list, in the one file
 * where a mistake is least visible.
 *
 * The catalogue below — labels, accelerators, the two security flags — stays here. A menu
 * label is main-process business and the renderer has no use for one.
 */
import {
  isMenuCommandId,
  MENU_COMMAND_IDS,
  type MenuCommandId,
} from '@shared/model/menu-commands.js';

export { MENU_COMMAND_IDS, isMenuCommandId, type MenuCommandId };

export interface MenuCommand {
  readonly id: MenuCommandId;
  /** Sentence case, written for a user. Title Case on macOS is applied by the OS, not us. */
  readonly label: string;
  /** True when running it requires an open vault, and therefore disables it while locked. */
  readonly needsUnlockedVault: boolean;
  /**
   * True when invoking it puts credential content in front of whoever invoked it, or
   * writes it somewhere. The tray refuses these outright — see the file header.
   */
  readonly exposesCredentialData: boolean;
  /** The matching entry in the renderer's shortcut registry, when there is one. */
  readonly shortcutId?: ShortcutIdRef | undefined;
  /** Electron accelerator spelling. Kept honest by `shortcut-parity.ts`. */
  readonly accelerator?: string | undefined;
}

/**
 * The table.
 *
 * Ordered by menu, so a reader can see the File menu without reconstructing it.
 */
export const MENU_COMMANDS: readonly MenuCommand[] = [
  // ── File ───────────────────────────────────────────────────────────────────
  {
    id: 'vault.new',
    label: 'New Vault…',
    // Creating a vault is what you do when you have none. Requiring one would be circular.
    needsUnlockedVault: false,
    exposesCredentialData: false,
    accelerator: 'CmdOrCtrl+Shift+N',
  },
  {
    id: 'vault.open',
    label: 'Open Vault…',
    needsUnlockedVault: false,
    exposesCredentialData: false,
    accelerator: 'CmdOrCtrl+O',
  },
  {
    id: 'vault.save',
    label: 'Save',
    needsUnlockedVault: true,
    exposesCredentialData: false,
    shortcutId: 'vault.save',
    accelerator: 'CmdOrCtrl+S',
  },
  {
    id: 'vault.lock',
    label: 'Lock Vault',
    // Locking an already-locked vault is a no-op that still reaches through the session.
    needsUnlockedVault: true,
    exposesCredentialData: false,
    shortcutId: 'vault.lock',
    accelerator: 'CmdOrCtrl+L',
  },
  {
    id: 'vault.close',
    label: 'Close Vault',
    needsUnlockedVault: true,
    exposesCredentialData: false,
  },
  {
    id: 'vault.import',
    label: 'Import…',
    // Import writes into a vault, so there has to be one open to write into.
    needsUnlockedVault: true,
    exposesCredentialData: false,
  },
  {
    id: 'vault.export',
    label: 'Export…',
    needsUnlockedVault: true,
    // Export's entire job is to take secrets out of the vault and put them in a file. It is
    // the clearest example of something that must never be one right-click from the tray.
    exposesCredentialData: true,
  },
  {
    id: 'vault.merge',
    label: 'Merge Another Copy…',
    // The other copy is opened with *this* vault's key, so there has to be one open.
    needsUnlockedVault: true,
    // False, and the distinction is worth stating because a merge plainly touches secrets.
    // The flag marks a command that puts credential data somewhere the user can read it —
    // an export file, a revealed field. A merge shows lengths where a value would be, writes
    // only an encrypted backup, and re-runs every decision in the main process. Nothing it
    // does is legible to anyone who has not already unlocked this vault.
    exposesCredentialData: false,
  },

  // ── Edit / Vault ───────────────────────────────────────────────────────────
  {
    id: 'credential.new',
    label: 'New Credential',
    needsUnlockedVault: true,
    exposesCredentialData: false,
    shortcutId: 'credential.new',
    accelerator: 'CmdOrCtrl+N',
  },
  {
    id: 'search.focus',
    label: 'Find…',
    needsUnlockedVault: true,
    exposesCredentialData: false,
    shortcutId: 'search.focus',
    accelerator: 'CmdOrCtrl+F',
  },
  {
    id: 'palette.open',
    label: 'Command Palette…',
    needsUnlockedVault: true,
    exposesCredentialData: false,
    shortcutId: 'palette.open',
    accelerator: 'CmdOrCtrl+K',
  },
  {
    id: 'vault.trash',
    label: 'Trash',
    needsUnlockedVault: true,
    exposesCredentialData: false,
    shortcutId: 'trash.toggle',
    accelerator: 'CmdOrCtrl+Shift+T',
  },
  {
    id: 'tools.generator',
    label: 'Password Generator…',
    // Generation is pure and needs no vault — choosing a password before you have somewhere
    // to put it is a reasonable thing to do, and the IPC layer already allows it.
    needsUnlockedVault: false,
    exposesCredentialData: false,
  },
  {
    id: 'tools.health',
    label: 'Vault Health…',
    needsUnlockedVault: true,
    exposesCredentialData: false,
  },
  {
    id: 'app.settings',
    label: 'Settings…',
    needsUnlockedVault: false,
    exposesCredentialData: false,
    // `CmdOrCtrl+,` renders as ⌘, on macOS and Ctrl+, on Windows — the convention on both,
    // from one string. Where it *sits* still differs by platform; see `menu-model.ts`.
    accelerator: 'CmdOrCtrl+,',
  },

  // ── View ───────────────────────────────────────────────────────────────────
  {
    id: 'view.sidebar',
    label: 'Toggle Sidebar',
    needsUnlockedVault: true,
    exposesCredentialData: false,
    shortcutId: 'sidebar.toggle',
    accelerator: 'CmdOrCtrl+B',
  },
  {
    id: 'view.theme.system',
    label: 'Match System',
    needsUnlockedVault: false,
    exposesCredentialData: false,
  },
  {
    id: 'view.theme.light',
    label: 'Light',
    needsUnlockedVault: false,
    exposesCredentialData: false,
  },
  {
    id: 'view.theme.dark',
    label: 'Dark',
    needsUnlockedVault: false,
    exposesCredentialData: false,
  },

  // ── Help ───────────────────────────────────────────────────────────────────
  {
    id: 'help.docs',
    label: 'Keyhold Help',
    needsUnlockedVault: false,
    exposesCredentialData: false,
  },
  {
    id: 'help.shortcuts',
    label: 'Keyboard Shortcuts',
    // A list of key names discloses nothing about the vault, and it is the one thing a
    // locked-out user reaches for. The renderer's table agrees (`whenLocked: true`) and
    // `shortcut-parity.ts` proves the two have not drifted.
    needsUnlockedVault: false,
    exposesCredentialData: false,
    shortcutId: 'shortcuts.help',
    accelerator: 'CmdOrCtrl+/',
  },
  {
    id: 'help.security',
    label: 'Security & Threat Model',
    needsUnlockedVault: false,
    exposesCredentialData: false,
  },
  {
    id: 'help.reportIssue',
    label: 'Report an Issue',
    needsUnlockedVault: false,
    exposesCredentialData: false,
  },
  {
    id: 'help.about',
    label: 'About Keyhold',
    needsUnlockedVault: false,
    exposesCredentialData: false,
  },

  // ── Window / lifecycle ─────────────────────────────────────────────────────
  //
  // Two commands rather than one with a computed label. A label that changes at render
  // time is a label a structural guard cannot check, and these two are the tray's entire
  // surface — the place where "checkable by construction" is worth the extra entry.
  {
    id: 'window.show',
    label: 'Show Keyhold',
    needsUnlockedVault: false,
    exposesCredentialData: false,
  },
  {
    id: 'window.hide',
    label: 'Hide Keyhold',
    needsUnlockedVault: false,
    exposesCredentialData: false,
  },
  {
    id: 'app.quit',
    label: 'Quit Keyhold',
    needsUnlockedVault: false,
    exposesCredentialData: false,
  },
];

export const MENU_COMMAND_BY_ID: ReadonlyMap<MenuCommandId, MenuCommand> = new Map(
  MENU_COMMANDS.map((command) => [command.id, command])
);

/**
 * Looks a command up, or throws.
 *
 * Throwing rather than returning `undefined`, for the same reason the renderer's shortcut
 * table does: every id in the union is in the table by construction, so a miss means the
 * union and the table have drifted. That should surface loudly at the first menu build, not
 * render as a blank menu row nobody notices.
 */
export function menuCommand(id: MenuCommandId): MenuCommand {
  const found = MENU_COMMAND_BY_ID.get(id);
  if (found === undefined) throw new Error(`Unknown menu command id: ${id}`);
  return found;
}

/** Every command that must be unavailable while the vault is locked. */
export function vaultCommandIds(): readonly MenuCommandId[] {
  return MENU_COMMANDS.filter((command) => command.needsUnlockedVault).map((command) => command.id);
}

/** Every command that may not appear in a surface outside the lock — i.e. the tray. */
export function credentialExposingCommandIds(): readonly MenuCommandId[] {
  return MENU_COMMANDS.filter((command) => command.exposesCredentialData).map(
    (command) => command.id
  );
}
