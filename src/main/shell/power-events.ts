// SPDX-License-Identifier: GPL-3.0-or-later
import { powerMonitor } from 'electron';

/**
 * The machine going away, and coming back.
 *
 * ## What this is NOT
 *
 * It is **not** a second lock-on-sleep. `src/main/session/auto-lock.ts` already registers
 * `suspend` and `lock-screen` whenever a vault is unlocked, already fires before the RAM
 * image is written to a hibernation file, and already exposes both as user settings
 * (`lockOnSleep`, `lockOnScreenLock`, decision D10). Adding a second registration here
 * would be a duplicate list (hard rule 8) with two concrete failure modes: the vault would
 * lock even for a user who deliberately turned that setting off, and two lock paths would
 * fire for one event, with only `lock()`'s idempotence saving us.
 *
 * So the shell **observes** and reports. What it does with the report is the app's decision,
 * wired in `src/main/index.ts` — see the report accompanying this phase.
 *
 * ## What it is for
 *
 * Two things auto-lock cannot cover, both of which are the shell's own business:
 *
 * - **`resume` / `unlock-screen`.** Nothing in the app handles these today. After a sleep
 *   the vault has been locked underneath the UI, and the menu and tray are still drawn for
 *   an unlocked vault until something refreshes them. A "Save" item that is clickable over
 *   a locked vault is precisely the dishonest menu item this phase set out to remove.
 * - **Hiding to the tray.** A window hidden to the tray fires neither `minimize` nor `blur`,
 *   so `lockOnMinimise` and `lockOnBlur` — the two settings a user would reasonably expect
 *   to cover "I put it away" — do not see it. That is a gap the tray itself introduces, and
 *   the tray closes it (see `tray.ts`), not this file.
 *
 * The listener is registered once and torn down explicitly. `powerMonitor` is a
 * process-global emitter; a shell that registered on each menu rebuild would accumulate
 * listeners for the life of the process and eventually trip Node's max-listeners warning
 * on a machine that sleeps a lot.
 */

export type PowerEvent =
  /** The machine is about to sleep. Fires before the memory image is written. */
  | 'suspend'
  /** The OS session was locked — Win+L, the macOS lock screen, a screensaver with a password. */
  | 'lock-screen'
  /** Woken from sleep. */
  | 'resume'
  /** The OS session was unlocked. */
  | 'unlock-screen';

export interface PowerWatchOptions {
  readonly onEvent: (event: PowerEvent) => void;
}

/** Stops watching. Always call it; see the file header on listener accumulation. */
export type PowerWatchHandle = () => void;

/**
 * Starts watching the four power events, and returns the teardown.
 *
 * Deliberately thin. There is no filtering, no debouncing and no state here, because every
 * one of those would be a decision that belongs to a caller which can be tested — and this
 * function cannot be, since `powerMonitor` needs a live Electron app.
 *
 * The four registrations are written out rather than looped: `powerMonitor.on` is typed as
 * one overload per event name, so a loop over a union of names would need a cast, and a
 * cast on an event-name argument is how you end up subscribed to a string the emitter
 * never emits — silently, forever.
 */
export function watchPowerEvents(options: PowerWatchOptions): PowerWatchHandle {
  const onSuspend = (): void => {
    options.onEvent('suspend');
  };
  const onLockScreen = (): void => {
    options.onEvent('lock-screen');
  };
  const onResume = (): void => {
    options.onEvent('resume');
  };
  const onUnlockScreen = (): void => {
    options.onEvent('unlock-screen');
  };

  powerMonitor.on('suspend', onSuspend);
  powerMonitor.on('lock-screen', onLockScreen);
  powerMonitor.on('resume', onResume);
  powerMonitor.on('unlock-screen', onUnlockScreen);

  return () => {
    powerMonitor.off('suspend', onSuspend);
    powerMonitor.off('lock-screen', onLockScreen);
    powerMonitor.off('resume', onResume);
    powerMonitor.off('unlock-screen', onUnlockScreen);
  };
}
