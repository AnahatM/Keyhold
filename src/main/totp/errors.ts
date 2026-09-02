// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Structured errors for the one-time-password engine.
 *
 * One rule governs every message in this file, and it is stricter than it first looks:
 *
 * **No message ever echoes any part of its input.** Not the seed, not the URI, not a
 * fragment of either, not "near `JBSW…`". A TOTP seed is a permanent second factor — unlike
 * a password it cannot be rotated without re-enrolling on the service — and errors get
 * logged, screenshotted and pasted into issue trackers. `errors.test.ts` and the property
 * test in `base32.test.ts` enforce this rather than trusting anyone to remember it.
 *
 * That rules out the shape a parser normally reaches for (`Invalid character "1" in "AB1C"`),
 * so every message here names the *rule that was broken* instead. The one thing that is
 * allowed through is a **character position**, because an index is a property of the string's
 * shape rather than of its content: it tells the user where to look at a value they are
 * already holding, and tells anyone reading the log nothing whatsoever about what is there.
 *
 * Deliberately **not** a `VaultError`. Nothing here means the vault file is damaged or the
 * password was wrong, and borrowing those codes would make a mistyped seed look like a
 * corrupt container in the UI and in the logs.
 */

export type TotpErrorCode =
  /** The base32 seed could not be decoded. */
  | 'INVALID_SEED'
  /** The `otpauth://` URI is not well formed, or is missing something required. */
  | 'INVALID_URI'
  /** A valid OTP URI, but for something this engine does not compute — HOTP. */
  | 'UNSUPPORTED_OTP_TYPE'
  /** A parameter was present and readable but out of range or unknown. */
  | 'INVALID_PARAMETER';

export class TotpError extends Error {
  readonly code: TotpErrorCode;

  constructor(code: TotpErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TotpError';
    this.code = code;
  }
}

/**
 * A seed that will not decode.
 *
 * `problem` completes the sentence "…could not be read because <problem>." It is written
 * here, in this file, from a fixed set of phrases — never interpolated from the input.
 */
export function invalidSeed(problem: string): TotpError {
  return new TotpError(
    'INVALID_SEED',
    `This one-time-password seed could not be read because ${problem}. The value itself is deliberately not shown here.`
  );
}

export function invalidUri(problem: string): TotpError {
  return new TotpError(
    'INVALID_URI',
    `This one-time-password link could not be read because ${problem}. The link itself is deliberately not shown here, because it contains the seed.`
  );
}

/**
 * A `otpauth://hotp/...` link.
 *
 * Rejected loudly rather than computed as if it were TOTP. HOTP codes advance on a counter
 * the client has to store and increment on every use; treating one as time-based would
 * produce six digits that look exactly like a valid code and are always wrong — the single
 * worst failure mode this module has, because the user would blame the service.
 */
export function hotpNotSupported(): TotpError {
  return new TotpError(
    'UNSUPPORTED_OTP_TYPE',
    'This is a counter-based (HOTP) one-time-password link. Keyhold generates time-based (TOTP) codes only, and will not guess at a counter it does not track. The seed has been kept, so nothing is lost if HOTP is added later.'
  );
}

export function unsupportedOtpType(): TotpError {
  return new TotpError(
    'UNSUPPORTED_OTP_TYPE',
    'This one-time-password link is not for a time-based code. Only "otpauth://totp/..." links are supported.'
  );
}

export function invalidParameter(problem: string): TotpError {
  return new TotpError('INVALID_PARAMETER', `This one-time password cannot be set up: ${problem}.`);
}
