// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { TotpError } from './errors.js';
import {
  parseOtpSecretField,
  totpSecretCodeFromField,
  verifyTotpSecretCodeAgainstField,
} from './secret-field.js';

/**
 * These are the two forms that are **already in users' vaults**, put there by the import
 * parsers before anything existed that could read them back.
 *
 * The fixture values are taken from this repository's own import and export tests — the
 * `otpauth://` one from `src/main/export/test-fixtures.ts`, the bare seed from the LastPass
 * parser's test — so if a parser ever starts writing a third shape, this file is where it
 * should fail.
 */

const URI_FIELD = 'otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP';
const BARE_FIELD = 'JBSWY3DPEHPK3PXP';

describe('reading whichever form the importer stored', () => {
  it('reads a full otpauth URI and says the parameters came from the record', () => {
    const configuration = parseOtpSecretField(URI_FIELD);
    try {
      expect(configuration.source).toBe('otpauth-uri');
      expect(configuration.parameters.issuer).toBe('Example');
      expect(configuration.parameters.account).toBe('ada');
      expect(configuration.secret.length).toBe(10);
    } finally {
      configuration.secret.destroy();
    }
  });

  it('reads a bare seed and says the parameters are assumed', () => {
    const configuration = parseOtpSecretField(BARE_FIELD);
    try {
      // The distinction matters to the UI: for a bare seed, "SHA-1, 6 digits, 30 seconds" is
      // what the format says to assume, not something the source actually told us.
      expect(configuration.source).toBe('bare-seed');
      expect(configuration.parameters).toEqual({
        algorithm: 'SHA1',
        digits: 6,
        periodSeconds: 30,
        issuer: null,
        account: null,
      });
    } finally {
      configuration.secret.destroy();
    }
  });

  it('gives both forms of the same seed the same code', () => {
    const now = 1_111_111_111_000;
    expect(totpSecretCodeFromField(URI_FIELD, now).secretCode).toBe(
      totpSecretCodeFromField(BARE_FIELD, now).secretCode
    );
  });
});

describe('the convenience entry points', () => {
  const NOW = 1_111_111_111_000;

  it('returns a code and the absolute instant it expires', () => {
    const result = totpSecretCodeFromField(BARE_FIELD, NOW);
    expect(result.secretCode).toHaveLength(6);
    expect(result.window.startsAt).toBe(1_111_111_110_000);
    expect(result.window.expiresAt).toBe(1_111_111_140_000);
    expect(result.window.periodMs).toBe(30_000);
  });

  it('verifies a code the user typed, allowing for a slow clock', () => {
    const current = totpSecretCodeFromField(BARE_FIELD, NOW).secretCode;
    const previous = totpSecretCodeFromField(BARE_FIELD, NOW - 30_000).secretCode;

    expect(verifyTotpSecretCodeAgainstField(BARE_FIELD, current, NOW).skewSteps).toBe(0);
    expect(verifyTotpSecretCodeAgainstField(BARE_FIELD, previous, NOW).skewSteps).toBe(-1);
    expect(
      verifyTotpSecretCodeAgainstField(BARE_FIELD, previous, NOW, { skewSteps: 0 }).valid
    ).toBe(false);
  });

  it('refuses a field it cannot read, rather than returning digits', () => {
    expect(() => totpSecretCodeFromField('', NOW)).toThrow(TotpError);
    // Note that "not a seed" would decode: n, o, t, a, s, e, e, d are all base32 letters.
    // That is exactly why the invalid cases here use characters outside the alphabet.
    expect(() => totpSecretCodeFromField('not-a-seed!', NOW)).toThrow(TotpError);
    expect(() => totpSecretCodeFromField('0000', NOW)).toThrow(TotpError);
    expect(() => totpSecretCodeFromField('otpauth://hotp/ada?secret=JBSWY3DP', NOW)).toThrow(
      TotpError
    );
  });

  it('does not leave the decoded seed alive after the call', () => {
    // The seed is decoded, used, and destroyed inside the call. Nothing that could hold it
    // afterwards is returned — the result is a string and four numbers.
    const result = totpSecretCodeFromField(URI_FIELD, NOW);
    expect(Object.keys(result).sort()).toEqual(['secretCode', 'window']);
    expect(JSON.stringify(result)).not.toContain('deadbeef');
  });
});
