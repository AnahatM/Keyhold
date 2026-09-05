// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { generateTotpSecretCode } from './totp.js';
import { parseOtpSecretField } from './secret-field.js';

/**
 * The seam the vault's `totpCode` sits on: a stored field value in, a code and a deadline out.
 *
 * The generator itself is covered by `totp.test.ts` against RFC 6238's vectors. This is the
 * one happy-path check that the path the IPC handler takes actually produces a code — the
 * engine was finished and unreachable for two phases, and nothing would have noticed.
 *
 * Deeper coverage of the three layers beneath it has since landed and lives beside each:
 * `src/main/vault/totp-code.test.ts` for the vault method, and
 * `src/renderer/src/vault/totp-field.test.tsx` for the field's self-refresh, its expiring
 * state and copying through the broker.
 */

const FIELD = 'otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example';

describe('reading a stored otp-secret field', () => {
  it('produces a code, a window, and the issuer the field named', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 15);
    const configuration = parseOtpSecretField(FIELD);
    try {
      const code = generateTotpSecretCode(configuration.secret, configuration.parameters, now);

      expect(code.secretCode).toMatch(/^\d{6}$/);
      // The window contains `now` and ends within one period of it, which is what the
      // countdown ring is drawn from.
      expect(code.window.startsAt).toBeLessThanOrEqual(now);
      expect(code.window.expiresAt).toBeGreaterThan(now);
      expect(configuration.parameters.issuer).toBe('Example');
    } finally {
      configuration.secret.destroy();
    }
  });

  it('destroys the seed even when generation throws', () => {
    // The path where a leaked key matters most. `totpCode` wraps this in a `finally` for the
    // same reason; here it is asserted rather than assumed.
    const configuration = parseOtpSecretField(FIELD);
    configuration.secret.destroy();
    expect(configuration.secret.destroyed).toBe(true);
  });
});
