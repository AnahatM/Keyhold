// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DEFAULT_SHELL_SETTINGS, coerceShellSettings } from './shell-settings.js';

/**
 * Tests for the shell's settings, and for the one piece of real logic in them.
 *
 * Coercion is worth testing here for the same reason `AutoLockSettings`' is: this value
 * arrives from a preferences file on disk that a user can hand-edit, that a crash can
 * truncate, and that a future version can add fields to. Field-by-field coercion means a
 * single bad value costs one setting rather than all four — and "all four" would silently
 * re-enable close-to-tray for somebody who had turned it off.
 *
 * The correction at the end is the part that is not merely defensive. `showTrayIcon: false`
 * together with `closeToTray: true` is not a preference, it is a lockout: the window hides
 * itself with nowhere to hide to, and there is no icon left to bring it back. That
 * combination is corrected rather than honoured, and this file is what stops the correction
 * being quietly dropped.
 */

describe('the defaults', () => {
  it('does not keep the process alive holding a decrypted vault unless asked', () => {
    // Close-to-tray trades the guarantee that the keys are gone for convenience. That is a
    // trade a user may make; it is not one to make on their behalf.
    expect(DEFAULT_SHELL_SETTINGS.closeToTray).toBe(false);
    expect(DEFAULT_SHELL_SETTINGS.minimiseToTray).toBe(false);
  });

  /**
   * On by default, because the tray opens the hole it closes.
   *
   * A window hidden with `hide()` fires neither `minimize` nor `blur`, so `lockOnMinimise`
   * and `lockOnBlur` — the two auto-lock settings a user would expect to cover "I put it
   * away" — never see it. Defaulting this off would mean turning close-to-tray on silently
   * disabled walk-away protection for the exact gesture that means "I have walked away".
   */
  it('locks when the window is put away into the tray', () => {
    expect(DEFAULT_SHELL_SETTINGS.lockOnHideToTray).toBe(true);
  });

  it('is not itself a lockout', () => {
    expect(coerceShellSettings(DEFAULT_SHELL_SETTINGS)).toEqual(DEFAULT_SHELL_SETTINGS);
  });
});

describe('coercing what was on disk', () => {
  it('falls back completely for something that is not an object', () => {
    for (const value of [undefined, null, 'true', 42, false]) {
      expect(coerceShellSettings(value), String(value)).toEqual(DEFAULT_SHELL_SETTINGS);
    }
  });

  it('keeps every field a stored object got right', () => {
    const stored = {
      closeToTray: true,
      minimiseToTray: true,
      lockOnHideToTray: false,
      showTrayIcon: true,
    };

    expect(coerceShellSettings(stored)).toEqual(stored);
  });

  it('fills in a field that is missing without discarding the ones that are not', () => {
    expect(coerceShellSettings({ closeToTray: true })).toEqual({
      ...DEFAULT_SHELL_SETTINGS,
      closeToTray: true,
    });
  });

  /**
   * The reason this is field-by-field rather than a whole-object validate-or-discard.
   *
   * A truncated write or a hand-edit that fat-fingers one value should cost that one value.
   * Throwing the object away would reset the other three to their defaults — which, for
   * `lockOnHideToTray`, means silently re-enabling something the user turned off, and for
   * `closeToTray` means silently turning off something they turned on.
   */
  it('degrades one bad field at a time', () => {
    const settings = coerceShellSettings({
      closeToTray: 'yes',
      minimiseToTray: true,
      lockOnHideToTray: null,
      showTrayIcon: true,
    });

    expect(settings).toEqual({
      closeToTray: DEFAULT_SHELL_SETTINGS.closeToTray,
      minimiseToTray: true,
      lockOnHideToTray: DEFAULT_SHELL_SETTINGS.lockOnHideToTray,
      showTrayIcon: true,
    });
  });

  it('ignores fields it does not know about', () => {
    const settings = coerceShellSettings({ closeToTray: true, futureSetting: 'hello' });

    expect(Object.keys(settings).sort()).toEqual([
      'closeToTray',
      'lockOnHideToTray',
      'minimiseToTray',
      'showTrayIcon',
    ]);
  });

  it('is idempotent, so a value can be stored and read back unchanged', () => {
    for (const stored of [
      {},
      { closeToTray: true },
      { showTrayIcon: false, minimiseToTray: true },
      { closeToTray: 'no', showTrayIcon: 0 },
    ]) {
      const once = coerceShellSettings(stored);
      expect(coerceShellSettings(once), JSON.stringify(stored)).toEqual(once);
    }
  });
});

describe('a tray-hiding gesture with no tray is a lockout, not a preference', () => {
  it('turns close-to-tray off when there is no tray', () => {
    expect(coerceShellSettings({ showTrayIcon: false, closeToTray: true })).toMatchObject({
      showTrayIcon: false,
      closeToTray: false,
    });
  });

  it('turns minimise-to-tray off when there is no tray', () => {
    expect(coerceShellSettings({ showTrayIcon: false, minimiseToTray: true })).toMatchObject({
      showTrayIcon: false,
      minimiseToTray: false,
    });
  });

  it('turns off both, not only the one that was named', () => {
    expect(
      coerceShellSettings({ showTrayIcon: false, closeToTray: true, minimiseToTray: true })
    ).toEqual({
      closeToTray: false,
      minimiseToTray: false,
      lockOnHideToTray: DEFAULT_SHELL_SETTINGS.lockOnHideToTray,
      showTrayIcon: false,
    });
  });

  it('leaves a trayless setup that hides nothing alone', () => {
    expect(coerceShellSettings({ showTrayIcon: false })).toEqual({
      ...DEFAULT_SHELL_SETTINGS,
      showTrayIcon: false,
    });
  });

  it('does not correct anything while there is a tray to hide into', () => {
    expect(
      coerceShellSettings({ showTrayIcon: true, closeToTray: true, minimiseToTray: true })
    ).toMatchObject({ closeToTray: true, minimiseToTray: true });
  });

  /**
   * The correction never touches the lock setting.
   *
   * Nothing about "there is no tray" is a reason to stop locking, and a correction that
   * reached one field further would turn a usability fix into a security regression.
   */
  it('does not disturb the lock setting on its way past', () => {
    for (const lockOnHideToTray of [true, false]) {
      expect(
        coerceShellSettings({ showTrayIcon: false, closeToTray: true, lockOnHideToTray })
      ).toMatchObject({ lockOnHideToTray });
    }
  });

  it('leaves no reachable combination that hides the window with no way back', () => {
    // Every one of the sixteen combinations, checked for the single unreachable state.
    for (let bits = 0; bits < 16; bits += 1) {
      const settings = coerceShellSettings({
        closeToTray: (bits & 1) !== 0,
        minimiseToTray: (bits & 2) !== 0,
        lockOnHideToTray: (bits & 4) !== 0,
        showTrayIcon: (bits & 8) !== 0,
      });

      const hidesItself = settings.closeToTray || settings.minimiseToTray;
      expect(hidesItself && !settings.showTrayIcon, JSON.stringify(settings)).toBe(false);
    }
  });
});
