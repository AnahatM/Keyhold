// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The time-based one-time-password engine.
 *
 * Main process only, because a TOTP seed is secret material — the record model classifies
 * `otp-secret` alongside `password` in `SECRET_CUSTOM_FIELD_TYPES` — and decision D13 keeps
 * secret material out of the renderer. A code crosses the bridge the way a revealed password
 * does: one at a time, on request, with an expiry. The seed never crosses at all.
 *
 *   parseOtpSecretField(value)        →  parameters + seed, from either stored form
 *   totpSecretCodeFromField(value, n) →  the code for instant `n`, seed destroyed on the way out
 *   verifyTotpSecretCodeAgainstField  →  does this typed code match, allowing for clock skew
 *   parseOtpauthUri / buildOtpauthSecretUri  →  the interchange format, both directions
 *   decodeBase32Secret / encodeBase32        →  RFC 4648, strict about what it will not read
 *
 * The non-secret shapes — algorithm, digits, period, and the window a code lives in — are in
 * `@shared/model/totp.ts`, because the renderer draws them and the countdown.
 *
 * Nothing here reads a clock. `now` is a parameter everywhere, which is what makes the RFC
 * 6238 published test vectors testable at all and what pins the period boundary down to the
 * millisecond. Import from this barrel, so the engine's public surface is one reviewable list.
 */

export * from './errors.js';
export * from './base32.js';
export * from './parameters.js';
export * from './totp.js';
export * from './uri.js';
export * from './secret-field.js';
