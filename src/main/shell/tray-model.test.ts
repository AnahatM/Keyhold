// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { MENU_COMMANDS, menuCommand, type MenuCommandId } from './menu-commands.js';
import {
  TRAY_COMMANDS,
  buildTrayModel,
  findTrayViolations,
  trayForbiddenCommandIds,
  trayTooltips,
  type TrayModel,
  type TrayState,
} from './tray-model.js';

/**
 * The tray restriction.
 *
 * A tray menu is not behind the lock. It renders whether the vault is open or not, it needs
 * no master password, and anyone standing at an unattended machine can open it with one
 * click. "Copy password for the last item you used", sitting behind a system icon, is a
 * credential exfiltration primitive with a friendly label on it.
 *
 * These tests are the enforcement, not the documentation of it.
 */

const APP = 'Keyhold';

function state(overrides: Partial<TrayState> = {}): TrayState {
  return { vaultUnlocked: true, windowVisible: true, appName: APP, ...overrides };
}

/** Every state the tray can be in. Small enough to enumerate, so it is enumerated. */
const EVERY_STATE: readonly TrayState[] = [
  state({ vaultUnlocked: true, windowVisible: true }),
  state({ vaultUnlocked: true, windowVisible: false }),
  state({ vaultUnlocked: false, windowVisible: true }),
  state({ vaultUnlocked: false, windowVisible: false }),
];

describe('nothing in the tray reveals a credential', () => {
  it('holds for every state the tray can be in', () => {
    for (const trayState of EVERY_STATE) {
      const violations = findTrayViolations(buildTrayModel(trayState), APP);
      expect(violations).toEqual([]);
    }
  });

  it('never renders a command classified as exposing credential data', () => {
    for (const trayState of EVERY_STATE) {
      for (const item of buildTrayModel(trayState).items) {
        expect(menuCommand(item.command).exposesCredentialData).toBe(false);
      }
    }
  });

  it('only ever renders allow-listed commands', () => {
    const allowed = new Set(TRAY_COMMANDS);
    for (const trayState of EVERY_STATE) {
      for (const item of buildTrayModel(trayState).items) {
        expect(allowed.has(item.command)).toBe(true);
      }
    }
  });

  /**
   * The guard is not vacuous.
   *
   * A classification with nothing in it passes every test above while proving nothing, and
   * it is exactly what a well-meaning tidy-up produces. This fails the day someone removes
   * the last `exposesCredentialData: true` from the catalogue.
   */
  it('has something to forbid', () => {
    expect(trayForbiddenCommandIds().length).toBeGreaterThan(0);
    expect(trayForbiddenCommandIds()).toContain('vault.export');
  });

  /**
   * The guard actually fires.
   *
   * Built by hand rather than through `buildTrayModel`, because the point is to check the
   * detector, not the builder — and the builder is (correctly) unable to produce this.
   */
  it('rejects a tray that has been given a credential-exposing command', () => {
    const compromised: TrayModel = {
      tooltip: trayTooltips(APP).unlocked,
      items: [{ command: 'vault.export', label: 'Export…', enabled: true }],
    };

    const violations = findTrayViolations(compromised, APP);

    expect(violations.map((violation) => violation.kind)).toContain('exposes-credential-data');
  });

  it('rejects a tray item that is not on the allow-list', () => {
    const compromised: TrayModel = {
      tooltip: trayTooltips(APP).locked,
      items: [{ command: 'tools.health', label: 'Vault Health…', enabled: true }],
    };

    expect(findTrayViolations(compromised, APP).map((violation) => violation.kind)).toContain(
      'not-allow-listed'
    );
  });
});

describe('the tooltip', () => {
  /**
   * The permitted form, written out rather than derived.
   *
   * The check below it — and `findTrayViolations` itself — compares the tooltip against
   * `trayTooltips()`, which is the same function that produced it. That is a *consistency*
   * check: it proves the tray renders what the tooltip function says, and it is structurally
   * incapable of noticing that the tooltip function now says too much. Fault injection
   * confirmed it: interpolating a vault path into `trayTooltips` moved both sides of the
   * comparison and the whole suite stayed green.
   *
   * So the shape is pinned here against a name that is obviously not the app's, which fixes
   * the *format* without pinning the app name. Widening what a tooltip may carry now requires
   * editing this file, which is a reviewable act rather than a one-line interpolation.
   */
  it('is the app name, a dash, and one of two words — and nothing else', () => {
    expect(trayTooltips('Ünïcødé Vault')).toEqual({
      locked: 'Ünïcødé Vault — locked',
      unlocked: 'Ünïcødé Vault — unlocked',
    });
  });

  it('says only the app name and the lock state, in every state', () => {
    for (const trayState of EVERY_STATE) {
      const { tooltip } = buildTrayModel(trayState);
      expect(tooltip, JSON.stringify(trayState)).toMatch(
        new RegExp(`^${APP} — (locked|unlocked)$`)
      );
    }
  });

  it('agrees with the two strings the guard checks against', () => {
    for (const trayState of EVERY_STATE) {
      const { tooltip } = buildTrayModel(trayState);
      const expected = trayTooltips(APP);
      expect([expected.locked, expected.unlocked]).toContain(tooltip);
    }
  });

  /**
   * A vault name or path in a hover tooltip tells a passer-by which vaults exist on this
   * machine and where they live. That is information the lock screen deliberately does not
   * show, handed out by a control that is not behind the lock.
   */
  it('rejects a tooltip carrying anything else', () => {
    const leaky: TrayModel = {
      tooltip: 'Keyhold — Work.keep (142 items)',
      items: [],
    };

    expect(findTrayViolations(leaky, APP).map((violation) => violation.kind)).toContain(
      'tooltip-leak'
    );
  });
});

describe('the three items', () => {
  it('offers Hide when the window is visible and Show when it is not', () => {
    const visible = buildTrayModel(state({ windowVisible: true })).items.map(
      (item) => item.command
    );
    const hidden = buildTrayModel(state({ windowVisible: false })).items.map(
      (item) => item.command
    );

    expect(visible).toContain('window.hide');
    expect(visible).not.toContain('window.show');
    expect(hidden).toContain('window.show');
    expect(hidden).not.toContain('window.hide');
  });

  it('disables Lock when there is nothing to lock', () => {
    const locked = buildTrayModel(state({ vaultUnlocked: false }));
    const item = locked.items.find((entry) => entry.command === 'vault.lock');

    expect(item?.enabled).toBe(false);
  });

  it('enables Lock over an open vault', () => {
    const unlocked = buildTrayModel(state({ vaultUnlocked: true }));
    const item = unlocked.items.find((entry) => entry.command === 'vault.lock');

    expect(item?.enabled).toBe(true);
  });

  it('always offers a way out', () => {
    for (const trayState of EVERY_STATE) {
      const commands: readonly MenuCommandId[] = buildTrayModel(trayState).items.map(
        (item) => item.command
      );
      expect(commands).toContain('app.quit');
      expect(commands).toHaveLength(3);
    }
  });
});

describe('the catalogue classification', () => {
  it('marks export as credential-exposing', () => {
    // Export's entire job is taking secrets out of the vault and writing them to a file.
    // If this is ever flipped to false the tray guard silently stops protecting anything.
    expect(menuCommand('vault.export').exposesCredentialData).toBe(true);
  });

  it('marks nothing on the tray allow-list as credential-exposing', () => {
    for (const id of TRAY_COMMANDS) {
      expect(menuCommand(id).exposesCredentialData).toBe(false);
    }
  });

  it('has a classification for every command', () => {
    for (const command of MENU_COMMANDS) {
      expect(typeof command.exposesCredentialData).toBe('boolean');
      expect(typeof command.needsUnlockedVault).toBe('boolean');
    }
  });
});
