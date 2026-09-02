// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Rate-limits unlock attempts.
 *
 * Worth being clear about what this does and does not buy, because it is easy to overstate:
 *
 * **It does not protect the vault file.** Anyone who can copy the `.keep` can attack it
 * offline at whatever speed their hardware allows, and no amount of app-side throttling
 * touches that. Argon2's memory hardness is the only defence there, and it is the real one.
 *
 * **What it does protect is the running app.** Someone who sits down at an unattended,
 * locked machine and starts guessing gets a handful of tries before the delay makes it
 * pointless. That is a genuine scenario — a colleague, a housemate, a hotel room — and it
 * is the one this file is for.
 *
 * The delay is deliberately not applied to the first few attempts. Typos are normal, and
 * punishing them makes the app feel hostile without deterring anyone.
 */

export const FREE_ATTEMPTS = 3;
export const BASE_DELAY_MS = 2_000;
export const MAX_DELAY_MS = 5 * 60_000;

export interface ThrottleState {
  readonly failedAttempts: number;
  /** Milliseconds until another attempt is allowed. Zero when one is allowed now. */
  readonly lockedForMs: number;
  /**
   * Absolute epoch-ms deadline, or 0 when not throttled.
   *
   * Sent alongside the duration because the renderer needs a *ticking* countdown, and a
   * duration is stale the instant it crosses the bridge. Given a fixed point the UI
   * subtracts a ticking clock from it — no mirrored state, no drift, and no impure
   * `Date.now()` during render. Both processes share a machine, so clock skew is moot.
   */
  readonly lockedUntil: number;
  readonly nextDelayMs: number;
}

export interface ThrottleOptions {
  readonly freeAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Injectable so tests do not have to sleep. */
  readonly now?: () => number;
}

export class UnlockThrottle {
  readonly #freeAttempts: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #now: () => number;

  #failedAttempts = 0;
  #blockedUntil = 0;

  constructor(options: ThrottleOptions = {}) {
    this.#freeAttempts = options.freeAttempts ?? FREE_ATTEMPTS;
    this.#baseDelayMs = options.baseDelayMs ?? BASE_DELAY_MS;
    this.#maxDelayMs = options.maxDelayMs ?? MAX_DELAY_MS;
    this.#now = options.now ?? Date.now;
  }

  get state(): ThrottleState {
    const remaining = Math.max(0, this.#blockedUntil - this.#now());
    return {
      failedAttempts: this.#failedAttempts,
      lockedForMs: remaining,
      lockedUntil: remaining > 0 ? this.#blockedUntil : 0,
      nextDelayMs: this.#delayAfter(this.#failedAttempts + 1),
    };
  }

  /** True when an attempt may be made right now. */
  canAttempt(): boolean {
    return this.#now() >= this.#blockedUntil;
  }

  /**
   * Records a failure and returns the resulting state.
   *
   * Doubling from a 2-second base: attempts 4, 5, 6 and 7 wait 2s, 4s, 8s and 16s, which
   * is barely noticeable to someone who mistyped and quickly intolerable to someone
   * guessing. The cap exists so a forgotten vault is never locked out for hours.
   */
  recordFailure(): ThrottleState {
    this.#failedAttempts += 1;
    const delay = this.#delayAfter(this.#failedAttempts);
    if (delay > 0) this.#blockedUntil = this.#now() + delay;
    return this.state;
  }

  /** Resets everything. Called on a successful unlock. */
  recordSuccess(): void {
    this.#failedAttempts = 0;
    this.#blockedUntil = 0;
  }

  #delayAfter(attempt: number): number {
    if (attempt <= this.#freeAttempts) return 0;
    const exponent = attempt - this.#freeAttempts - 1;
    return Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** exponent);
  }
}
