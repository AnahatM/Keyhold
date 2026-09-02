// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  MENU_COMMANDS,
  MENU_COMMAND_BY_ID,
  MENU_COMMAND_IDS,
  credentialExposingCommandIds,
  menuCommand,
  vaultCommandIds,
  type MenuCommandId,
} from './menu-commands.js';

/**
 * The catalogue's own guard — and specifically, a guard on the two security fields that
 * nothing else in the suite can check.
 *
 * ## Why the classification is written down a second time here
 *
 * `menu-model.test.ts` asserts that every command marked `needsUnlockedVault` is disabled
 * while the vault is locked, and it reads that mark from the catalogue rather than from a
 * list of its own — deliberately, so it cannot go stale when a command is added. But that
 * makes it a *consistency* check: it proves the menu agrees with the catalogue, and it is
 * structurally incapable of noticing that the catalogue is wrong. Flip `vault.export` to
 * `needsUnlockedVault: false` and the guard stops checking Export and passes, while Export
 * becomes clickable over a locked vault. That was confirmed by fault injection, which is why
 * this file exists.
 *
 * So the two sets are pinned here, by name. This is not the second list hard rule 8 forbids —
 * nothing reads it at runtime, and the menu still has exactly one source of truth. It is the
 * guard hard rule 9 asks for: the effect of pinning the sets is that *loosening* a security
 * classification cannot be done by editing one boolean. It requires editing this file too,
 * which is a reviewable act rather than a plausible-looking one-character diff.
 *
 * Adding a new lock-gated command is a one-line addition here and nothing else. Removing one
 * is meant to be inconvenient.
 */

/**
 * Every command that must be unavailable while the vault is locked.
 *
 * The test is that this set and the catalogue's own answer are *equal*, in both directions —
 * so a command that quietly loses the flag fails, and a command that quietly gains one fails
 * too. The second direction matters less but costs nothing, and a command that became
 * lock-gated by accident is a menu item that stops working for reasons nobody can find.
 */
const MUST_BE_LOCKED: readonly MenuCommandId[] = [
  'vault.save',
  'vault.lock',
  'vault.close',
  'vault.import',
  'vault.export',
  'credential.new',
  'search.focus',
  'palette.open',
  'view.sidebar',
  'vault.trash',
  'tools.health',
];

/**
 * Every command that puts credential content in front of whoever invoked it.
 *
 * `tray-model.ts` refuses to place any of these, and the tray is not behind the lock — it is
 * one right-click away for anyone standing at an unattended machine. This is the flag that
 * makes "Copy password in the tray menu" impossible to add by accident.
 */
const MUST_BE_CREDENTIAL_EXPOSING: readonly MenuCommandId[] = ['vault.export'];

const sorted = (ids: readonly MenuCommandId[]): readonly string[] => [...ids].sort();

describe('the lock classification', () => {
  it('gates exactly the commands that reach an open vault', () => {
    expect(sorted(vaultCommandIds())).toEqual(sorted(MUST_BE_LOCKED));
  });

  it('does not gate the commands a locked-out user needs', () => {
    // Opening a vault, reading the shortcut sheet, generating a password before there is
    // anywhere to put it, and quitting. Gating any of these would lock a user out of the
    // only things left to do.
    for (const id of [
      'vault.new',
      'vault.open',
      'tools.generator',
      'app.settings',
      'help.shortcuts',
      'help.security',
      'window.show',
      'app.quit',
    ] as const) {
      expect(menuCommand(id).needsUnlockedVault, id).toBe(false);
    }
  });

  it('has something to gate, so the guard cannot pass vacuously', () => {
    expect(MUST_BE_LOCKED.length).toBeGreaterThan(0);
    expect(vaultCommandIds().length).toBe(MUST_BE_LOCKED.length);
  });
});

describe('the credential-exposure classification', () => {
  it('flags exactly the commands that take secrets out of the vault', () => {
    expect(sorted(credentialExposingCommandIds())).toEqual(sorted(MUST_BE_CREDENTIAL_EXPOSING));
  });

  it('flags export, whose entire job is to write secrets to a file', () => {
    expect(menuCommand('vault.export').exposesCredentialData).toBe(true);
  });

  it('never flags something without also gating it behind the lock', () => {
    // A command that hands out credential data but is allowed over a locked vault would be
    // the worst of both fields. Nothing should ever be in one set and not the other.
    for (const id of credentialExposingCommandIds()) {
      expect(menuCommand(id).needsUnlockedVault, id).toBe(true);
    }
  });
});

describe('the catalogue as a registry', () => {
  it('holds exactly one entry per id in the union', () => {
    expect(MENU_COMMANDS).toHaveLength(MENU_COMMAND_IDS.length);
    expect(MENU_COMMAND_BY_ID.size).toBe(MENU_COMMAND_IDS.length);
  });

  it('lists no id twice', () => {
    const ids = MENU_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(MENU_COMMAND_IDS).size).toBe(MENU_COMMAND_IDS.length);
  });

  it('has an entry for every id the union declares', () => {
    for (const id of MENU_COMMAND_IDS) {
      expect(() => menuCommand(id), id).not.toThrow();
    }
  });

  /**
   * Throwing rather than returning `undefined`, for the same reason the renderer's shortcut
   * table does: a miss means the union and the table have drifted, and that should surface
   * loudly at the first menu build rather than render as a blank menu row nobody notices.
   */
  it('throws loudly for an id it does not know', () => {
    expect(() => menuCommand('vault.teleport' as MenuCommandId)).toThrow(/Unknown menu command/);
  });

  it('gives every command a label written for a person', () => {
    for (const command of MENU_COMMANDS) {
      expect(command.label.trim(), command.id).not.toBe('');
      // Sentence case, not Title Case: macOS applies its own capitalisation, we do not.
      expect(command.label, command.id).not.toMatch(/_|^\s|\s$/);
    }
  });

  it('gives no two commands the same label', () => {
    const labels = MENU_COMMANDS.map((command) => command.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  /**
   * A `shortcutId` with no accelerator is a renderer binding the menu claims to mirror and
   * then does not show, which is the drift `shortcut-parity.ts` exists to catch — except that
   * it cannot, because a binding with no accelerator never reaches it.
   */
  it('gives every command that names a renderer shortcut an accelerator to show', () => {
    for (const command of MENU_COMMANDS) {
      if (command.shortcutId === undefined) continue;
      expect(command.accelerator, command.id).toBeDefined();
    }
  });

  it('names no renderer shortcut twice', () => {
    const shortcutIds = MENU_COMMANDS.map((command) => command.shortcutId).filter(
      (id): id is string => id !== undefined
    );
    expect(new Set(shortcutIds).size).toBe(shortcutIds.length);
  });

  it('binds no accelerator to two different commands', () => {
    const accelerators = MENU_COMMANDS.map((command) => command.accelerator).filter(
      (accelerator): accelerator is string => accelerator !== undefined
    );
    expect(new Set(accelerators).size).toBe(accelerators.length);
  });
});
