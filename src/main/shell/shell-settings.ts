// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Settings for the native shell.
 *
 * Shaped exactly like `AutoLockSettings` in `src/main/session/auto-lock.ts` — a plain
 * interface, a `DEFAULT_*` constant, and a field-by-field coercion function — so that
 * `PreferencesStore` can adopt it the same way, and so a hand-edited or truncated
 * preferences file degrades one field at a time instead of throwing every setting away.
 *
 * Decision D10: every behaviour here is a user choice, and the defaults are the
 * conservative reading of each one.
 */

export interface ShellSettings {
  /**
   * Whether closing the window hides it to the tray instead of closing the app.
   *
   * **Off by default, and honestly labelled.** A Keyhold that keeps running holds a
   * decrypted vault — the DEK and every decrypted record — in the memory of a process the
   * user believes they have finished with. Today, closing the last window locks the vault
   * and (off macOS) quits, which guarantees the keys are gone. Close-to-tray trades that
   * guarantee for convenience, so it is opt-in and the settings copy has to say what is
   * being traded rather than calling it "keep Keyhold running in the background".
   */
  readonly closeToTray: boolean;
  /** Whether minimising hides to the tray rather than to the taskbar. */
  readonly minimiseToTray: boolean;
  /**
   * Lock the vault when the window is hidden to the tray.
   *
   * **On by default**, and it closes a gap the tray itself opens. A window hidden with
   * `hide()` fires neither `minimize` nor `blur`, so `lockOnMinimise` and `lockOnBlur` —
   * the two auto-lock settings a user would expect to cover "I put it away" — never see it.
   * Without this, turning close-to-tray on would silently disable the walk-away protection
   * for the exact gesture that means "I have walked away".
   */
  readonly lockOnHideToTray: boolean;
  /** Whether the tray icon exists at all. Off means no tray and no tray menu. */
  readonly showTrayIcon: boolean;
}

export const DEFAULT_SHELL_SETTINGS: ShellSettings = {
  closeToTray: false,
  minimiseToTray: false,
  lockOnHideToTray: true,
  showTrayIcon: true,
};

/** Validates settings arriving from stored preferences or from the renderer. */
export function coerceShellSettings(value: unknown): ShellSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_SHELL_SETTINGS;
  const raw = value as Record<string, unknown>;

  const boolOr = (key: keyof ShellSettings, fallback: boolean): boolean =>
    typeof raw[key] === 'boolean' ? raw[key] : fallback;

  const settings: ShellSettings = {
    closeToTray: boolOr('closeToTray', DEFAULT_SHELL_SETTINGS.closeToTray),
    minimiseToTray: boolOr('minimiseToTray', DEFAULT_SHELL_SETTINGS.minimiseToTray),
    lockOnHideToTray: boolOr('lockOnHideToTray', DEFAULT_SHELL_SETTINGS.lockOnHideToTray),
    showTrayIcon: boolOr('showTrayIcon', DEFAULT_SHELL_SETTINGS.showTrayIcon),
  };

  // A tray-hiding gesture with no tray to hide into leaves the window unreachable: hidden,
  // not minimised, and with no icon to bring it back. The combination is not a preference,
  // it is a lockout, so it is corrected rather than honoured.
  if (!settings.showTrayIcon && (settings.closeToTray || settings.minimiseToTray)) {
    return { ...settings, closeToTray: false, minimiseToTray: false };
  }

  return settings;
}
