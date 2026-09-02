// SPDX-License-Identifier: GPL-3.0-or-later
import { MENU_COMMANDS, menuCommand, type MenuCommandId } from './menu-commands.js';

/**
 * The tray / menu-bar menu, as data.
 *
 * ## The tray is outside the lock
 *
 * This is the whole design constraint and it is easy to lose sight of. The main window can
 * be locked, blurred, hidden and auto-locked. The tray menu cannot: it is one click on a
 * system icon, it renders whether or not the vault is open, and anyone standing at an
 * unattended machine can open it without touching the app. A tray menu is, for practical
 * purposes, an unauthenticated surface.
 *
 * So **nothing in it may reveal or copy a credential**. No recent items, no quick-copy, no
 * "last used login", no search. Those are the features that make a tray menu feel powerful
 * in a note-taking app and make it a vulnerability in a password manager: "copy the password
 * for the highlighted item" behind a system icon is a credential exfiltration primitive with
 * a nice icon on it.
 *
 * That rule is enforced structurally rather than by memory:
 *
 * 1. Tray items are `MenuCommandId`s, never free-form labels — so a new tray entry has to be
 *    a catalogue entry first, where it is classified.
 * 2. `TRAY_COMMANDS` is an explicit allow-list of three.
 * 3. `findTrayViolations` fails the build if any item carries `exposesCredentialData`, or if
 *    an item outside the allow-list appears.
 *
 * Adding "Copy password" to the tray therefore requires deliberately mis-declaring it in the
 * catalogue — a reviewable act, not an oversight.
 *
 * ## The tooltip
 *
 * It says whether the vault is locked and nothing else. Never the vault's name, never its
 * path, never a record count. The lock state is already visible to anyone who can see the
 * screen and is the one genuinely useful thing an indicator can say; a file path in a
 * hover tooltip tells a passer-by which vaults exist on the machine and where.
 */

/**
 * The complete tray surface. Three items.
 *
 * Show/hide, lock now, quit — the three things that are safe to do without proving who you
 * are, because none of them reads anything. Locking and quitting are strictly *reducing*
 * access; showing the window reveals only what the window already decides to show, which is
 * an unlock screen when the vault is locked.
 */
export const TRAY_COMMANDS: readonly MenuCommandId[] = [
  'window.show',
  'window.hide',
  'vault.lock',
  'app.quit',
];

export interface TrayItem {
  readonly command: MenuCommandId;
  readonly label: string;
  readonly enabled: boolean;
}

export interface TrayModel {
  readonly tooltip: string;
  readonly items: readonly TrayItem[];
}

export interface TrayState {
  readonly vaultUnlocked: boolean;
  /** Whether the main window is currently visible; drives Show vs Hide. */
  readonly windowVisible: boolean;
  readonly appName: string;
}

/**
 * The two tooltips, spelled out as constants.
 *
 * A guard asserts the tooltip is one of exactly these two. Interpolating anything else —
 * a vault name, a path, an unsaved-changes count — is then a test failure rather than a
 * judgement call at review time.
 */
export function trayTooltips(appName: string): { locked: string; unlocked: string } {
  return {
    locked: `${appName} — locked`,
    unlocked: `${appName} — unlocked`,
  };
}

export function buildTrayModel(state: TrayState): TrayModel {
  const tooltips = trayTooltips(state.appName);

  // One of Show/Hide, never both: two entries where only one can ever apply is a menu the
  // user has to read twice.
  const visibility: MenuCommandId = state.windowVisible ? 'window.hide' : 'window.show';

  const ids: readonly MenuCommandId[] = [visibility, 'vault.lock', 'app.quit'];

  const items: readonly TrayItem[] = ids.map((id) => {
    const command = menuCommand(id);
    return {
      command: command.id,
      label: command.label,
      // Same rule as the menu: "Lock" over an already-locked vault is disabled rather than
      // present-and-inert.
      enabled: !command.needsUnlockedVault || state.vaultUnlocked,
    };
  });

  return {
    tooltip: state.vaultUnlocked ? tooltips.unlocked : tooltips.locked,
    items,
  };
}

export type TrayViolationKind =
  /** An item that reveals or copies credential material. The one that must never happen. */
  | 'exposes-credential-data'
  /** An item outside the three-command allow-list. */
  | 'not-allow-listed'
  /** A tooltip carrying something other than the app name and the lock state. */
  | 'tooltip-leak';

export interface TrayViolation {
  readonly kind: TrayViolationKind;
  readonly detail: string;
}

/**
 * The tray guard.
 *
 * Returns an empty array for a safe tray. `tray-model.test.ts` asserts that for every state
 * the tray can be in, and fault injection confirms it fires — see the report.
 *
 * Written over the *rendered model* rather than over `TRAY_COMMANDS`, deliberately: checking
 * the allow-list against itself would pass no matter what `buildTrayModel` actually emits.
 * The thing that reaches the user is what gets checked.
 */
export function findTrayViolations(model: TrayModel, appName: string): readonly TrayViolation[] {
  const violations: TrayViolation[] = [];
  const allowed = new Set(TRAY_COMMANDS);

  for (const item of model.items) {
    const command = menuCommand(item.command);

    if (command.exposesCredentialData) {
      violations.push({
        kind: 'exposes-credential-data',
        detail: `tray item "${item.label}" (${item.command}) reveals credential data, and the tray is not behind the lock`,
      });
    }

    if (!allowed.has(item.command)) {
      violations.push({
        kind: 'not-allow-listed',
        detail: `tray item "${item.command}" is not in TRAY_COMMANDS`,
      });
    }
  }

  const tooltips = trayTooltips(appName);
  if (model.tooltip !== tooltips.locked && model.tooltip !== tooltips.unlocked) {
    violations.push({
      kind: 'tooltip-leak',
      detail: `tray tooltip "${model.tooltip}" is neither of the two permitted strings`,
    });
  }

  return violations;
}

/**
 * The catalogue commands that must never reach the tray.
 *
 * Exported so the guard test can assert the classification is non-empty — a security guard
 * whose forbidden set is empty passes vacuously and would keep passing after someone
 * "tidied up" the flag.
 */
export function trayForbiddenCommandIds(): readonly MenuCommandId[] {
  return MENU_COMMANDS.filter((command) => command.exposesCredentialData).map(
    (command) => command.id
  );
}
