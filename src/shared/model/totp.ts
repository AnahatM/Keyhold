// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The shape of a one-time-password configuration, and the arithmetic of the window a code
 * lives inside.
 *
 * Lives in `@shared` because the renderer draws the code, its issuer, and the countdown ring
 * around it, so it needs to describe a configuration and to know when the current code dies.
 * It does **not** live here because the renderer computes anything: generation runs in the
 * main process only — see `src/main/totp/` — for the same reason every other secret does.
 * The seed is secret material (`SECRET_CUSTOM_FIELD_TYPES` in `credential.ts` classifies
 * `otp-secret` alongside `password`), and a seed in the renderer would be a permanent second
 * factor sitting in the semi-trusted process. Decision D13.
 *
 * **This file is types, declarative constants and pure arithmetic. No Node imports and no
 * secret-bearing type appears in it** — it compiles into the renderer bundle unchanged, and
 * nothing declared here can carry a seed or a code by accident.
 *
 * ## What is safe to describe here
 *
 * The algorithm, the digit count, the period, the issuer and the account name are all
 * non-secret: they are printed on the enrolment page next to the QR code, and knowing them
 * without the seed buys an attacker nothing. The seed and the generated code are the secret
 * half, and neither has a home in this file.
 */

// ── Algorithms ───────────────────────────────────────────────────────────────

/**
 * The three HMAC functions RFC 6238 defines TOTP over.
 *
 * A runtime array as well as a type, for the same reason as `CUSTOM_FIELD_TYPES` and
 * `HISTORY_ACTIONS`: anything validating a value that arrived from a file or an IPC payload
 * needs something to check against, and a hand-written list at each of those sites is three
 * lists that will disagree.
 *
 * SHA-1 leads because it is the default in the `otpauth://` Key Uri Format and what
 * essentially every real service issues. It is not a weakness here: HMAC-SHA1 is unbroken,
 * and the collision attacks that retired SHA-1 for signatures do not apply to HMAC.
 */
export const TOTP_ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'] as const;
export type TotpAlgorithm = (typeof TOTP_ALGORITHMS)[number];

export function isTotpAlgorithm(value: unknown): value is TotpAlgorithm {
  return typeof value === 'string' && (TOTP_ALGORITHMS as readonly string[]).includes(value);
}

// ── Parameters ───────────────────────────────────────────────────────────────

/**
 * Everything about a one-time password **except** the seed.
 *
 * `issuer` and `account` are the two halves of the `otpauth://` label. They are kept apart
 * rather than stored as one display string because they are separately useful — the issuer
 * groups codes in a list, the account disambiguates two accounts on the same service — and
 * because a joined string cannot be split back reliably once an account name contains a
 * colon.
 *
 * `null` rather than optional for both: with `exactOptionalPropertyTypes` an absent property
 * and a present-but-undefined one are different types, and this shape is built by a parser,
 * serialised, and compared. One representation of "not given" is one fewer way to be wrong.
 */
export interface TotpParameters {
  readonly algorithm: TotpAlgorithm;
  /** How many digits the code has. 6 unless the service said otherwise. */
  readonly digits: number;
  /** How long a code is valid, in seconds. 30 unless the service said otherwise. */
  readonly periodSeconds: number;
  readonly issuer: string | null;
  readonly account: string | null;
}

/**
 * The values the Key Uri Format says to assume when a parameter is absent.
 *
 * These are not our preferences — they are what every other authenticator assumes, and
 * differing from them by even one would produce codes that are confidently wrong for every
 * URI that omits a parameter, which is most of them.
 */
export const TOTP_DEFAULTS: Pick<TotpParameters, 'algorithm' | 'digits' | 'periodSeconds'> = {
  algorithm: 'SHA1',
  digits: 6,
  periodSeconds: 30,
};

/**
 * The accepted ranges.
 *
 * `minDigits` is 6 because RFC 4226 requires at least six, and a shorter code is brute-
 * forceable inside one period. `maxDigits` is 10 because dynamic truncation yields a 31-bit
 * integer, so digits beyond the tenth would be a leading zero on every single code — not
 * more security, just a wider box.
 *
 * `maxPeriodSeconds` is a day. Nothing real uses more than 60, but the bound exists so a
 * malformed URI claiming `period=99999999999` is rejected by a rule rather than by whatever
 * the arithmetic happens to do.
 */
export interface TotpLimits {
  readonly minDigits: number;
  readonly maxDigits: number;
  readonly minPeriodSeconds: number;
  readonly maxPeriodSeconds: number;
  readonly maxSkewSteps: number;
}

export const TOTP_LIMITS: TotpLimits = {
  minDigits: 6,
  maxDigits: 10,
  minPeriodSeconds: 1,
  maxPeriodSeconds: 86_400,
  maxSkewSteps: 10,
};

export function isTotpDigits(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= TOTP_LIMITS.minDigits &&
    value <= TOTP_LIMITS.maxDigits
  );
}

export function isTotpPeriodSeconds(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= TOTP_LIMITS.minPeriodSeconds &&
    value <= TOTP_LIMITS.maxPeriodSeconds
  );
}

/**
 * How many steps either side of "now" a code is accepted when **verifying**.
 *
 * One step is the near-universal choice, and it is a real trade: it triples the number of
 * codes an attacker may guess at any instant (three of 10^6 rather than one), in exchange
 * for a user whose clock is thirty seconds out being able to log in at all. See
 * `verifyTotpSecretCode` for why this never applies to generating a code.
 */
export const TOTP_DEFAULT_SKEW_STEPS = 1;

// ── The window a code lives in ───────────────────────────────────────────────

/**
 * The time step a code belongs to, expressed as **absolute instants**.
 *
 * ## Why an instant and not "seconds remaining"
 *
 * A duration is correct only at the moment it is computed. Every millisecond after that it
 * is a lie, and the lie grows: by the time "23 seconds left" has been serialised, pushed
 * across the contextBridge, put into a Zustand store and rendered, some of those seconds are
 * gone — and if the renderer is busy, or the machine sleeps mid-countdown, the number is
 * wrong by an unbounded amount with nothing to correct it against.
 *
 * An absolute deadline does not go stale. The renderer subtracts its own `Date.now()` on
 * every animation frame and is right every time, including after a sleep, a garbage-collection
 * pause, or a slow IPC round trip. This codebase has already learned that lesson once — the
 * secret broker's grants carry `expiresAt`, not a TTL countdown, for exactly this reason.
 *
 * `startsAt` is inclusive and `expiresAt` is exclusive: at `expiresAt` the *next* code is
 * already the current one. That is the boundary the period-rollover test pins down.
 */
export interface TotpWindow {
  /** RFC 6238's `T` — the number of whole periods since the Unix epoch. */
  readonly counter: number;
  /** Unix ms at which this code became current. Inclusive. */
  readonly startsAt: number;
  /** Unix ms at which this code stops being current. Exclusive. */
  readonly expiresAt: number;
  readonly periodMs: number;
}

/**
 * Milliseconds until the code changes, clamped to `[0, periodMs]`.
 *
 * Clamped rather than allowed to go negative because the caller is a countdown: a UI that
 * receives -400 and renders it will draw a ring that has gone backwards past zero. A stale
 * window should read as "expired", which is what 0 means.
 */
export function totpRemainingMs(codeWindow: TotpWindow, now: number): number {
  const remaining = codeWindow.expiresAt - now;
  if (remaining <= 0) return 0;
  return Math.min(remaining, codeWindow.periodMs);
}

/**
 * How far through its life this code is: 0 at `startsAt`, approaching 1 at `expiresAt`.
 *
 * Exposed so the ring, the bar and the "about to expire" colour change all read the same
 * number. Three components each dividing by the period themselves is three chances to pick a
 * different rounding and have them disagree on screen.
 */
export function totpProgress(codeWindow: TotpWindow, now: number): number {
  return 1 - totpRemainingMs(codeWindow, now) / codeWindow.periodMs;
}

// ── What crosses the bridge ──────────────────────────────────────────────────

/**
 * A TOTP code as the renderer receives it.
 *
 * The **seed** never crosses — it is `otp-secret` material, `src/main/totp/secret-field.ts`
 * destroys the key before returning, and nothing here can reconstruct it. The **code** does,
 * because a code the user cannot see is a code they cannot type. It is a live authentication
 * factor until its window closes, so it travels the way a revealed password does: on demand,
 * one at a time, never logged and never in an error.
 *
 * `expiresAt` is absolute rather than a remaining-seconds count. A duration computed in main
 * is already stale by the length of the round trip, and a countdown that says 29 when it
 * should say 27 is how somebody types a code that has just died.
 */
export interface TotpCodeView {
  readonly secretCode: string;
  /** Epoch ms at which this code stops being valid. The renderer counts down to it. */
  readonly expiresAt: number;
  readonly periodSeconds: number;
  readonly digits: number;
  /** The issuer the field named, when it named one. */
  readonly issuer: string | null;
  /**
   * True when the URI's label and its `issuer` parameter disagreed.
   *
   * Surfaced rather than resolved: two different names usually means the field was pasted
   * from somewhere else, and silently picking one shows a code under the wrong account.
   */
  readonly issuerMismatch: boolean;
}
