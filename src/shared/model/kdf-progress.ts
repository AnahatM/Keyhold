// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * How far through an Argon2 derivation the app believes it is.
 *
 * **Predicted, not measured.** Argon2 reports nothing while it runs and cannot be chunked, so
 * this is computed from how long derivations have taken on this machine before. The reason it
 * exists at all is that `CLAUDE.md` calls a frozen window during unlock a bug: a wait of one
 * or two seconds with no feedback reads as a hang, and on a vault configured for a high cost
 * it can be far longer than that.
 *
 * Carries no parameters and no path. A KDF cost is not secret, but there is nothing here that
 * needs it either — the renderer draws a bar, and a bar needs a fraction and a reason to
 * apologise.
 */
export interface KdfProgressView {
  /** 0 to just under 1. Never 1: completion is the operation ending, not the bar filling. */
  readonly fraction: number;
  readonly elapsedMs: number;
  /** What this machine's timings predicted. Shown as an estimate, never as a deadline. */
  readonly estimatedMs: number;
  /** Past the estimate — the UI should say so rather than let a stalled bar speak for it. */
  readonly overdue: boolean;
}
