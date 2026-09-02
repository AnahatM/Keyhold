// SPDX-License-Identifier: GPL-3.0-or-later
import {
  isTotpAlgorithm,
  TOTP_DEFAULTS,
  TOTP_LIMITS,
  type TotpAlgorithm,
  type TotpParameters,
} from '@shared/model/totp.js';
import { invalidParameter } from './errors.js';

/**
 * Reading the non-secret half of a one-time-password configuration out of untrusted strings.
 *
 * Separate from `uri.ts` because these rules are needed twice — once when parsing an
 * `otpauth://` link, once when validating a configuration the user typed into the editor —
 * and rule 8 in `CLAUDE.md` is that there is no second list. Separate from `totp.ts` because
 * the generator should be handed parameters that are already known good, so the arithmetic
 * has no branch for "what if digits is 0".
 *
 * ## Reject rather than fall back
 *
 * Every function here throws on an unreadable value instead of substituting the default.
 * A URI saying `algorithm=SHA-3` is not a URI that meant SHA-1; quietly generating SHA-1
 * codes for it would produce the same failure the base32 decoder refuses to produce — six
 * plausible digits that never work. The one place a default *is* used is a parameter that is
 * genuinely **absent**, which the Key Uri Format defines as meaning the default.
 *
 * No message here echoes its input. See the header of `errors.ts`: a caller cannot know
 * whether the string it was handed is a parameter or a mangled seed, so nothing is echoed.
 */

/**
 * `SHA1`, `sha1` and `SHA-1` are all the same algorithm.
 *
 * The hyphenated spelling is the one people type and the one some exporters write, since it
 * is how the hash is named everywhere except in this URI format. Accepting it costs one
 * `replace` and prevents a rejection the user cannot act on.
 */
export function normaliseAlgorithm(raw: string): TotpAlgorithm {
  const candidate = raw.trim().replace(/-/g, '').toUpperCase();
  if (!isTotpAlgorithm(candidate)) {
    throw invalidParameter(
      'its algorithm is not one this app can compute. Only SHA1, SHA256 and SHA512 are defined for time-based codes'
    );
  }
  return candidate;
}

/**
 * Parses a digit count.
 *
 * `Number.parseInt` is deliberately not used: it reads `8abc` as 8 and `8.5` as 8, so a
 * malformed parameter would be silently accepted as a well-formed one. The pattern check
 * first means only a string that is entirely digits gets as far as the range check.
 */
export function normaliseDigits(raw: string): number {
  const digits = readWholeNumber(raw);
  if (digits === null || digits < TOTP_LIMITS.minDigits || digits > TOTP_LIMITS.maxDigits) {
    throw invalidParameter(
      `its code length is outside the range this app supports (${TOTP_LIMITS.minDigits} to ${TOTP_LIMITS.maxDigits} digits)`
    );
  }
  return digits;
}

export function normalisePeriodSeconds(raw: string): number {
  const period = readWholeNumber(raw);
  if (
    period === null ||
    period < TOTP_LIMITS.minPeriodSeconds ||
    period > TOTP_LIMITS.maxPeriodSeconds
  ) {
    throw invalidParameter(
      `its refresh period is outside the range this app supports (${TOTP_LIMITS.minPeriodSeconds} to ${TOTP_LIMITS.maxPeriodSeconds} seconds)`
    );
  }
  return period;
}

function readWholeNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** The configuration a bare seed with no other information implies. */
export function defaultTotpParameters(): TotpParameters {
  return {
    algorithm: TOTP_DEFAULTS.algorithm,
    digits: TOTP_DEFAULTS.digits,
    periodSeconds: TOTP_DEFAULTS.periodSeconds,
    issuer: null,
    account: null,
  };
}

/**
 * Re-checks parameters at the point of use.
 *
 * Not redundant with the parsers above: parameters also arrive from the vault file, from an
 * IPC payload, and from a merge — none of which went through `normaliseDigits`, and all of
 * which are outside this process's control. Types are erased at runtime, so the only thing
 * standing between a hand-edited `"digits": 0` and a division that yields `NaN` is this
 * function.
 */
export function assertTotpParameters(parameters: TotpParameters): void {
  if (!isTotpAlgorithm(parameters.algorithm)) {
    throw invalidParameter('its algorithm is not one of SHA1, SHA256 or SHA512');
  }
  if (
    !Number.isInteger(parameters.digits) ||
    parameters.digits < TOTP_LIMITS.minDigits ||
    parameters.digits > TOTP_LIMITS.maxDigits
  ) {
    throw invalidParameter(
      `its code length must be a whole number between ${TOTP_LIMITS.minDigits} and ${TOTP_LIMITS.maxDigits}`
    );
  }
  if (
    !Number.isInteger(parameters.periodSeconds) ||
    parameters.periodSeconds < TOTP_LIMITS.minPeriodSeconds ||
    parameters.periodSeconds > TOTP_LIMITS.maxPeriodSeconds
  ) {
    throw invalidParameter(
      `its refresh period must be a whole number of seconds between ${TOTP_LIMITS.minPeriodSeconds} and ${TOTP_LIMITS.maxPeriodSeconds}`
    );
  }
}
