// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Progress arithmetic and the words that go with it.
 *
 * Small, but the two things it does are the two things a progress bar gets wrong:
 * a fill wider than its track when a caller reports 7 of 5 items done, and a bar that
 * says nothing to a screen reader because `aria-valuenow` was set without
 * `aria-valuetext`.
 */

/** Below this, a determinate bar is still drawn as a sliver so it is visibly present. */
const MIN_VISIBLE_PERCENT = 2;

/**
 * `value` as a percentage of `max`, clamped to 0–100.
 *
 * Clamping rather than trusting the caller because progress genuinely does overshoot in
 * this app: an import reports rows processed against an estimated row count, and an
 * estimate that was low would otherwise paint a bar past the end of its track.
 */
export function progressPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  const ratio = (value / max) * 100;
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(100, Math.max(0, ratio));
}

/** The width to paint: never a zero-width fill for work that has genuinely started. */
export function progressFillPercent(value: number, max: number): number {
  const percent = progressPercent(value, max);
  if (percent === 0) return 0;
  return Math.max(MIN_VISIBLE_PERCENT, percent);
}

/**
 * The spoken form of the progress.
 *
 * `aria-valuenow` alone is announced as a bare number, which for "3" of "417 credentials"
 * is worse than useless. `aria-valuetext` replaces it with something a person would say.
 *
 * `unit` should be plural and lower case — "credentials", "entries", "files".
 */
export function progressValueText(value: number, max: number, unit?: string): string {
  const percent = Math.round(progressPercent(value, max));
  if (unit === undefined) return `${percent}%`;
  return `${Math.max(0, Math.round(value))} of ${Math.max(0, Math.round(max))} ${unit} — ${percent}%`;
}

/**
 * When to admit that something is taking a while.
 *
 * Argon2 takes seconds *by design* — that is the entire point of a memory-hard KDF, and it
 * is the one place in Keyhold where a long wait is a feature. But an unexplained frozen
 * three seconds is indistinguishable from a hang, and the user's next move is to kill the
 * app mid-write. So a bar that is still running after this long says why out loud rather
 * than leaving them to guess.
 */
export const SLOW_OPERATION_MS = 1_500;
