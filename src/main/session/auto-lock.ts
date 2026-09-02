// SPDX-License-Identifier: GPL-3.0-or-later
import { powerMonitor, type BrowserWindow } from 'electron';

/**
 * Locks the vault when the user has plausibly walked away.
 *
 * The threat this addresses is the ordinary one, not the exotic one: an unlocked laptop in
 * an office, a coffee shop, or a shared house. Every trigger below corresponds to a real
 * "they are not at the machine any more" signal.
 *
 * **Idle time is measured by the OS, not by the app.** `powerMonitor.getSystemIdleTime()`
 * reports genuine input inactivity across the whole system, so time spent working in
 * another application correctly counts as *not* idle. Tracking activity inside Keyhold's
 * own window instead would lock the vault while the user was actively working two windows
 * over — which trains people to raise the timeout until it is useless, or disable it.
 *
 * **Locking never saves.** An unattended write is how a half-finished edit becomes the
 * saved state. Unsaved changes are prompted about while the user is still present.
 */

export interface AutoLockSettings {
  /** Minutes of system-wide idleness before locking. `null` disables the idle trigger. */
  readonly idleMinutes: number | null;
  readonly lockOnSleep: boolean;
  readonly lockOnScreenLock: boolean;
  /** Off by default: minimising to check something else is not walking away. */
  readonly lockOnMinimise: boolean;
  readonly lockOnBlur: boolean;
}

export const DEFAULT_AUTO_LOCK: AutoLockSettings = {
  idleMinutes: 10,
  lockOnSleep: true,
  lockOnScreenLock: true,
  lockOnMinimise: false,
  lockOnBlur: false,
};

export type LockReason = 'idle' | 'sleep' | 'screen-lock' | 'minimise' | 'blur' | 'manual';

/** How often system idle time is polled. Cheap, and one second of granularity is plenty. */
const POLL_INTERVAL_MS = 1_000;

export class AutoLock {
  #settings: AutoLockSettings;
  #timer: NodeJS.Timeout | undefined;
  #teardown: (() => void)[] = [];
  #armed = false;

  constructor(
    private readonly onLock: (reason: LockReason) => void,
    settings: AutoLockSettings = DEFAULT_AUTO_LOCK
  ) {
    this.#settings = settings;
  }

  get settings(): AutoLockSettings {
    return this.#settings;
  }

  /** Applies new settings, restarting the watchers if currently armed. */
  configure(settings: AutoLockSettings): void {
    this.#settings = settings;
    if (this.#armed) {
      this.disarm();
      this.arm();
    }
  }

  /** Starts watching. Called when a vault is unlocked — never before. */
  arm(window?: BrowserWindow): void {
    this.disarm();
    this.#armed = true;

    if (this.#settings.idleMinutes !== null && this.#settings.idleMinutes > 0) {
      const thresholdSeconds = this.#settings.idleMinutes * 60;
      this.#timer = setInterval(() => {
        if (powerMonitor.getSystemIdleTime() >= thresholdSeconds) this.#fire('idle');
      }, POLL_INTERVAL_MS);
      // Never hold the process open for a poll.
      this.#timer.unref();
    }

    if (this.#settings.lockOnSleep) {
      // `suspend` fires before the machine sleeps, so the keys are gone before the RAM
      // image is written — which matters on a machine without full-disk encryption,
      // where the hibernation file is readable.
      const onSuspend = (): void => {
        this.#fire('sleep');
      };
      powerMonitor.on('suspend', onSuspend);
      this.#teardown.push(() => powerMonitor.off('suspend', onSuspend));
    }

    if (this.#settings.lockOnScreenLock) {
      const onLockScreen = (): void => {
        this.#fire('screen-lock');
      };
      powerMonitor.on('lock-screen', onLockScreen);
      this.#teardown.push(() => powerMonitor.off('lock-screen', onLockScreen));
    }

    if (window !== undefined && !window.isDestroyed()) {
      if (this.#settings.lockOnMinimise) {
        const onMinimise = (): void => {
          this.#fire('minimise');
        };
        window.on('minimize', onMinimise);
        this.#teardown.push(() => {
          if (!window.isDestroyed()) window.off('minimize', onMinimise);
        });
      }

      if (this.#settings.lockOnBlur) {
        const onBlur = (): void => {
          this.#fire('blur');
        };
        window.on('blur', onBlur);
        this.#teardown.push(() => {
          if (!window.isDestroyed()) window.off('blur', onBlur);
        });
      }
    }
  }

  /** Stops watching. Called on lock, so a locked vault is not locked repeatedly. */
  disarm(): void {
    this.#armed = false;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    for (const off of this.#teardown) off();
    this.#teardown = [];
  }

  #fire(reason: LockReason): void {
    if (!this.#armed) return;
    // Disarm first: the lock handler is synchronous, and a second trigger arriving mid-lock
    // would call it again on an already-locked vault.
    this.disarm();
    this.onLock(reason);
  }
}

/** Validates settings arriving from stored preferences or from the renderer. */
export function coerceAutoLockSettings(value: unknown): AutoLockSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_AUTO_LOCK;
  const raw = value as Record<string, unknown>;

  const idleMinutes =
    typeof raw.idleMinutes === 'number' && Number.isFinite(raw.idleMinutes) && raw.idleMinutes > 0
      ? Math.min(24 * 60, Math.round(raw.idleMinutes))
      : raw.idleMinutes === null
        ? null
        : DEFAULT_AUTO_LOCK.idleMinutes;

  const boolOr = (key: string, fallback: boolean): boolean =>
    typeof raw[key] === 'boolean' ? raw[key] : fallback;

  return {
    idleMinutes,
    lockOnSleep: boolOr('lockOnSleep', DEFAULT_AUTO_LOCK.lockOnSleep),
    lockOnScreenLock: boolOr('lockOnScreenLock', DEFAULT_AUTO_LOCK.lockOnScreenLock),
    lockOnMinimise: boolOr('lockOnMinimise', DEFAULT_AUTO_LOCK.lockOnMinimise),
    lockOnBlur: boolOr('lockOnBlur', DEFAULT_AUTO_LOCK.lockOnBlur),
  };
}
