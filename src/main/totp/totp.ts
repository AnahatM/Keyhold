// SPDX-License-Identifier: GPL-3.0-or-later
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  TOTP_DEFAULT_SKEW_STEPS,
  TOTP_LIMITS,
  type TotpAlgorithm,
  type TotpParameters,
  type TotpWindow,
} from '@shared/model/totp.js';
import type { SecretBytes } from '../crypto/secret.js';
import { invalidParameter } from './errors.js';
import { assertTotpParameters } from './parameters.js';

/**
 * HOTP (RFC 4226) and TOTP (RFC 6238), over standard primitives only.
 *
 * There is no cryptography invented in this file. HMAC comes from Node's `crypto`, which is
 * OpenSSL; the only arithmetic here is RFC 4226's dynamic truncation, which is a byte offset
 * and a modulo. That matters because hard rule 3 forbids inventing crypto, and because a
 * bespoke HMAC would be the single easiest place in this codebase to be subtly wrong for
 * years without anyone noticing — TOTP has no error detection at all, so a wrong
 * implementation and a right one both emit six digits.
 *
 * ## `now` is a parameter, and that is not negotiable
 *
 * Nothing in this file reads a clock. `now` arrives from the caller in Unix milliseconds,
 * exactly as `analyseVault` in `../health/rules.ts` takes its `now`, and for the same three
 * reasons:
 *
 *  1. **The RFC's published test vectors are times.** Verifying against them requires being
 *     able to *say* it is 1970-01-01T00:00:59Z. A module that reads `Date.now()` internally
 *     can only be tested by mocking the global clock, which is a test that proves the mock
 *     works.
 *  2. **The period boundary is where off-by-one lives**, and the only way to test the instant
 *     a code rolls over is to name that instant.
 *  3. **A code is a pure function of (seed, parameters, instant).** Making that literally
 *     true in the signature means a caller can generate the code for an instant it chooses —
 *     which is what lets the UI pre-compute the next code before the current one lapses, and
 *     what lets verification walk a skew window without lying about the time.
 *
 * ## What is secret here
 *
 * The seed (`SecretBytes`) and the generated code. Per the naming convention in `CLAUDE.md`,
 * anything carrying the code says so: `TotpSecretCode.secretCode`, `generateTotpSecretCode`,
 * `verifyTotpSecretCode`. The `TotpWindow` alongside it is pure timing and carries nothing.
 * Neither the seed nor the code appears in any error thrown from this file.
 */

/** Our algorithm names → Node's. Node wants the OpenSSL spelling, which is lower case. */
const NODE_DIGEST: Readonly<Record<TotpAlgorithm, string>> = {
  SHA1: 'sha1',
  SHA256: 'sha256',
  SHA512: 'sha512',
};

const MS_PER_SECOND = 1000;
const COUNTER_BYTES = 8;
const UINT32_RANGE = 0x1_0000_0000;

// ── RFC 4226: the counter-based primitive ────────────────────────────────────

/**
 * One HOTP code, per RFC 4226 §5.3.
 *
 * Exported because it is the primitive TOTP is defined in terms of, and because RFC 4226
 * publishes its own test vectors — being able to assert against those proves the truncation
 * and the modulo are right independently of any time arithmetic.
 *
 * Exporting it is **not** support for HOTP accounts. `uri.ts` still refuses an
 * `otpauth://hotp/` link, because using HOTP for real means storing a counter, incrementing
 * it on every use, persisting that increment atomically, and resynchronising when the user
 * generates a code they never type. None of that exists, and half of it would be a
 * data-integrity feature rather than a crypto one.
 */
export function hmacOtpSecretCode(
  secret: SecretBytes,
  counter: number,
  algorithm: TotpAlgorithm,
  digits: number
): string {
  const digest = secret.use((bytes) =>
    createHmac(NODE_DIGEST[algorithm], bytes).update(counterToBytes(counter)).digest()
  );

  // Dynamic truncation. The low nibble of the final byte picks a 4-byte window; masking the
  // high bit of the first of those makes the result a positive 31-bit integer on every
  // platform, which is the whole reason the RFC specifies the mask rather than leaving sign
  // handling to the implementation.
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * The counter as 8 bytes, big-endian.
 *
 * Written as two 32-bit halves rather than with `BigInt`: the counter for any representable
 * date fits comfortably in a double (RFC 6238's furthest test vector, the year 2603, is
 * counter 666,666,666), and `writeBigUInt64BE` would mean converting to and from `BigInt` on
 * every single code generation for a range we can prove we never leave.
 */
function counterToBytes(counter: number): Buffer {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw invalidParameter(
      'the time given is before 1970, or too far in the future to be represented. One-time-password counters are never negative'
    );
  }

  const bytes = Buffer.alloc(COUNTER_BYTES);
  bytes.writeUInt32BE(Math.floor(counter / UINT32_RANGE), 0);
  // `>>> 0` is ToUint32, which is exactly "the low 32 bits" for any safe integer.
  bytes.writeUInt32BE(counter >>> 0, 4);
  return bytes;
}

// ── RFC 6238: the time-based construction ────────────────────────────────────

/**
 * Which time step `now` falls in, and when that step begins and ends.
 *
 * Floors twice — to whole seconds, then to whole periods — rather than dividing the
 * milliseconds by the period in one go. `Math.floor` is correct for negative numbers too, so
 * a pre-epoch `now` produces a negative counter that `counterToBytes` then rejects with a
 * sentence, instead of a `RangeError` from a buffer write.
 *
 * RFC 6238's `T0` (an epoch offset other than 0) is deliberately not supported. The
 * `otpauth://` Key Uri Format has no way to express it, so a `T0` set here could not survive
 * an export, an import, or a move to another authenticator — a value the vault could hold and
 * never round-trip. Nothing in the wild uses it.
 */
export function totpWindowAt(now: number, periodSeconds: number): TotpWindow {
  const periodMs = periodSeconds * MS_PER_SECOND;
  const counter = Math.floor(Math.floor(now / MS_PER_SECOND) / periodSeconds);
  const startsAt = counter * periodMs;
  return { counter, startsAt, expiresAt: startsAt + periodMs, periodMs };
}

/**
 * A generated code and the window it is valid in.
 *
 * `secretCode` is secret material for as long as the window lasts. It is not a password —
 * it dies on its own in under a minute — but it is a live authentication factor until then,
 * so it obeys the same rules: never logged, never in an error, and out to the renderer only
 * through the reveal path with a TTL.
 */
export interface TotpSecretCode {
  readonly secretCode: string;
  readonly window: TotpWindow;
}

/**
 * The code for a given instant.
 *
 * Always the exact step `now` falls in. **The skew window is not used here** — see
 * `verifyTotpSecretCode`.
 */
export function generateTotpSecretCode(
  secret: SecretBytes,
  parameters: TotpParameters,
  now: number
): TotpSecretCode {
  assertTotpParameters(parameters);
  const window = totpWindowAt(now, parameters.periodSeconds);
  return {
    secretCode: hmacOtpSecretCode(secret, window.counter, parameters.algorithm, parameters.digits),
    window,
  };
}

// ── Verification, and the clock-skew window ──────────────────────────────────

export interface TotpVerifyOptions {
  /**
   * How many steps either side of `now` to accept. Defaults to
   * `TOTP_DEFAULT_SKEW_STEPS` (1); 0 means "this instant only".
   */
  readonly skewSteps?: number;
}

export interface TotpVerification {
  readonly valid: boolean;
  /**
   * Which step matched, relative to `now`: 0 for the current one, -1 for the previous, +1
   * for the next. `null` when nothing matched.
   *
   * Surfaced rather than swallowed because it is a diagnosis. A user whose codes only ever
   * match at -1 has a clock roughly a period slow, and that is worth telling them — it is
   * the single most common cause of "my authenticator stopped working", and it is invisible
   * from a plain true/false.
   */
  readonly skewSteps: number | null;
}

/**
 * Checks a code the user typed against the seed.
 *
 * ## Why there is a window at all, and why generation does not get one
 *
 * TOTP's one real-world failure mode is a wrong clock. A machine thirty seconds slow
 * produces the previous step's code, the service rejects it, and nothing anywhere says why —
 * the user sees six digits that look perfectly normal being refused, over and over. So a
 * *verifier* accepts one step either side, which covers the drift an unsynchronised machine
 * accumulates in practice.
 *
 * **Generation gets no such tolerance, and must not.** A generated code is sent to somebody
 * else's verifier, which has its own window; widening ours would just move the guess. There
 * is no "probably right" code to emit — there is the code for the step we are in, and if our
 * clock is wrong the honest fix is to fix the clock, not to pick one of three answers. Any
 * caller that wants a neighbouring step can ask for it by name, by passing a different `now`.
 *
 * The comparison is `timingSafeEqual`, and **every step in the window is compared even after
 * one has matched**, so the time taken depends on the window size and nothing else. A short
 * circuit would leak which step matched through timing — weak, but free to avoid.
 */
export function verifyTotpSecretCode(
  secret: SecretBytes,
  parameters: TotpParameters,
  candidateSecretCode: string,
  now: number,
  options: TotpVerifyOptions = {}
): TotpVerification {
  assertTotpParameters(parameters);

  const skewSteps = options.skewSteps ?? TOTP_DEFAULT_SKEW_STEPS;
  if (!Number.isInteger(skewSteps) || skewSteps < 0 || skewSteps > TOTP_LIMITS.maxSkewSteps) {
    throw invalidParameter(
      `the clock-skew allowance must be a whole number of steps between 0 and ${TOTP_LIMITS.maxSkewSteps}`
    );
  }

  // Humans type codes with the grouping the service prints them in. Length is a property of
  // the format, not of the secret, so a wrong-length candidate is rejected without a compare.
  const candidate = candidateSecretCode.replace(/[\s-]+/gu, '');
  if (candidate.length !== parameters.digits) return { valid: false, skewSteps: null };

  const candidateBytes = Buffer.from(candidate, 'utf8');
  const base = totpWindowAt(now, parameters.periodSeconds).counter;

  let matched: number | null = null;
  for (let step = -skewSteps; step <= skewSteps; step += 1) {
    const counter = base + step;
    if (counter < 0) continue;

    const expected = hmacOtpSecretCode(secret, counter, parameters.algorithm, parameters.digits);
    const expectedBytes = Buffer.from(expected, 'utf8');
    if (
      expectedBytes.length === candidateBytes.length &&
      timingSafeEqual(expectedBytes, candidateBytes) &&
      matched === null
    ) {
      matched = step;
    }
  }

  return { valid: matched !== null, skewSteps: matched };
}
