// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SecretBytes } from '../crypto/secret.js';
import { decodeBase32 } from './base32.js';
import { TotpError } from './errors.js';
import { buildOtpauthSecretUri, isOtpauthUri, parseOtpauthUri } from './uri.js';
import type { ParsedOtpauth } from './uri.js';

/**
 * The `otpauth://` variations here are not invented. Each one is a shape some real exporter
 * or enrolment page produces, and several of them already sit in this repository's own import
 * fixtures — which is how the seeds below were chosen.
 */

const SEED = 'JBSWY3DPEHPK3PXP';
const SEED_HEX = '48656c6c6f21deadbeef';

/** Parses, asserts on the result, and destroys the key the parser handed over. */
function withParsed<T>(secretUri: string, inspect: (parsed: ParsedOtpauth) => T): T {
  const parsed = parseOtpauthUri(secretUri);
  try {
    return inspect(parsed);
  } finally {
    parsed.secret.destroy();
  }
}

const seedHexOf = (parsed: ParsedOtpauth): string =>
  parsed.secret.use((bytes) => Buffer.from(bytes).toString('hex'));

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TotpError);
    return (error as TotpError).message;
  }
  throw new Error('expected the call to throw, but it returned');
}

describe('the ordinary case', () => {
  it('reads the shape every authenticator emits', () => {
    withParsed(
      `otpauth://totp/Big%20Corp:ada@example.com?secret=${SEED}&issuer=Big%20Corp`,
      (p) => {
        expect(p.parameters).toEqual({
          algorithm: 'SHA1',
          digits: 6,
          periodSeconds: 30,
          issuer: 'Big Corp',
          account: 'ada@example.com',
        });
        expect(seedHexOf(p)).toBe(SEED_HEX);
        expect(p.issuerMismatch).toBe(false);
      }
    );
  });

  it('applies the format defaults when parameters are absent', () => {
    withParsed(`otpauth://totp/ada?secret=${SEED}`, (p) => {
      expect(p.parameters.algorithm).toBe('SHA1');
      expect(p.parameters.digits).toBe(6);
      expect(p.parameters.periodSeconds).toBe(30);
    });
  });

  it('reads every parameter when they are all given', () => {
    withParsed(
      `otpauth://totp/Example:ada?secret=${SEED}&issuer=Example&algorithm=SHA512&digits=8&period=60`,
      (p) => {
        expect(p.parameters.algorithm).toBe('SHA512');
        expect(p.parameters.digits).toBe(8);
        expect(p.parameters.periodSeconds).toBe(60);
      }
    );
  });
});

describe('the label, in every shape it turns up in', () => {
  it.each([
    ['issuer and account', 'Example:ada', 'Example', 'ada'],
    ['a percent-encoded colon', 'Example%3Aada', 'Example', 'ada'],
    ['the optional space after the colon', 'Example:%20ada', 'Example', 'ada'],
    ['an account only', 'ada@example.com', null, 'ada@example.com'],
    ['a percent-encoded label', 'Big%20Corp:ada%40example.com', 'Big Corp', 'ada@example.com'],
    [
      'an account containing a colon',
      'Example:sip:ada@example.com',
      'Example',
      'sip:ada@example.com',
    ],
    ['an empty label', '', null, null],
    ['an empty account after the issuer', 'Example:', 'Example', null],
  ])('reads %s', (_description, label, issuer, account) => {
    withParsed(`otpauth://totp/${label}?secret=${SEED}`, (p) => {
      expect(p.parameters.issuer).toBe(issuer);
      expect(p.parameters.account).toBe(account);
    });
  });

  it('splits on the first colon, so an issuer is never taken from the account', () => {
    // The reason the query parameter is authoritative: this label alone cannot tell you
    // whether "sip" is part of the account or a second issuer.
    withParsed(`otpauth://totp/sip:ada@example.com?secret=${SEED}&issuer=Example`, (p) => {
      expect(p.parameters.issuer).toBe('Example');
      expect(p.labelIssuer).toBe('sip');
      expect(p.parameters.account).toBe('ada@example.com');
      expect(p.issuerMismatch).toBe(true);
    });
  });
});

describe('the issuer conflict', () => {
  it('lets the query parameter win, and keeps the label issuer for the UI', () => {
    withParsed(`otpauth://totp/Old%20Name:ada?secret=${SEED}&issuer=New%20Name`, (p) => {
      expect(p.parameters.issuer).toBe('New Name');
      expect(p.labelIssuer).toBe('Old Name');
      expect(p.issuerMismatch).toBe(true);
    });
  });

  it('falls back to the label when there is no parameter', () => {
    withParsed(`otpauth://totp/Example:ada?secret=${SEED}`, (p) => {
      expect(p.parameters.issuer).toBe('Example');
      expect(p.labelIssuer).toBe('Example');
      expect(p.issuerMismatch).toBe(false);
    });
  });

  it('does not call a difference of case or spacing a mismatch', () => {
    withParsed(`otpauth://totp/%20GitHub%20:ada?secret=${SEED}&issuer=github`, (p) => {
      expect(p.issuerMismatch).toBe(false);
      expect(p.parameters.issuer).toBe('github');
    });
  });

  it('takes the label issuer when the parameter is present but empty', () => {
    withParsed(`otpauth://totp/Example:ada?secret=${SEED}&issuer=`, (p) => {
      expect(p.parameters.issuer).toBe('Example');
      expect(p.issuerMismatch).toBe(false);
    });
  });
});

describe('parameter spellings', () => {
  it.each([
    ['SHA1', 'SHA1'],
    ['sha1', 'SHA1'],
    ['SHA-1', 'SHA1'],
    ['sha-256', 'SHA256'],
    ['SHA512', 'SHA512'],
  ])('accepts algorithm=%s', (spelling, expected) => {
    withParsed(`otpauth://totp/ada?secret=${SEED}&algorithm=${spelling}`, (p) => {
      expect(p.parameters.algorithm).toBe(expected);
    });
  });

  it('accepts an upper-case type, which WHATWG does not fold for a non-special scheme', () => {
    withParsed(`OTPAUTH://TOTP/ada?secret=${SEED}`, (p) => {
      expect(p.parameters.account).toBe('ada');
    });
  });

  it('ignores parameters it does not know', () => {
    withParsed(`otpauth://totp/ada?secret=${SEED}&image=https://x/y.png&lock=true`, (p) => {
      expect(p.parameters.digits).toBe(6);
    });
  });

  it('accepts a seed written the way a person would paste it', () => {
    withParsed(`otpauth://totp/ada?secret=${encodeURIComponent('jbsw y3dp ehpk 3pxp')}`, (p) => {
      expect(seedHexOf(p)).toBe(SEED_HEX);
    });
  });
});

describe('what is refused', () => {
  it('refuses HOTP by name, rather than computing a wrong TOTP for it', () => {
    const message = messageOf(() => parseOtpauthUri(`otpauth://hotp/ada?secret=${SEED}&counter=0`));
    expect(message).toContain('counter-based');
    expect(message).toContain('HOTP');
    try {
      parseOtpauthUri(`otpauth://hotp/ada?secret=${SEED}&counter=0`);
    } catch (error) {
      expect((error as TotpError).code).toBe('UNSUPPORTED_OTP_TYPE');
    }
  });

  it.each([
    ['another scheme entirely', `https://example.com/?secret=${SEED}`],
    ['a bare seed', SEED],
    ['an unknown OTP type', `otpauth://steam/ada?secret=${SEED}`],
    ['no type at all', `otpauth:totp/ada?secret=${SEED}`],
    ['no secret parameter', 'otpauth://totp/ada?issuer=Example'],
    ['an empty secret parameter', 'otpauth://totp/ada?secret='],
    ['a seed that is not base32', 'otpauth://totp/ada?secret=NOT!VALID'],
    ['an unknown algorithm', `otpauth://totp/ada?secret=${SEED}&algorithm=SHA3`],
    ['a digit count of zero', `otpauth://totp/ada?secret=${SEED}&digits=0`],
    ['a fractional digit count', `otpauth://totp/ada?secret=${SEED}&digits=6.5`],
    ['a trailing-garbage digit count', `otpauth://totp/ada?secret=${SEED}&digits=6abc`],
    ['a period of zero', `otpauth://totp/ada?secret=${SEED}&period=0`],
    ['a negative period', `otpauth://totp/ada?secret=${SEED}&period=-30`],
    ['a broken percent-escape in the label', `otpauth://totp/ada%ZZ?secret=${SEED}`],
  ])('refuses %s', (_description, secretUri) => {
    expect(() => parseOtpauthUri(secretUri)).toThrow(TotpError);
  });

  it('never echoes the seed, whole or in fragments', () => {
    const cases = [
      `otpauth://totp/ada?secret=${SEED}&algorithm=SHA3`,
      `otpauth://totp/ada?secret=${SEED}&digits=99`,
      `otpauth://totp/ada?secret=${SEED}&period=0`,
      `otpauth://totp/ada%ZZ?secret=${SEED}`,
      'otpauth://totp/ada?secret=JBSWY3DP0HPK3PXP',
    ];

    for (const secretUri of cases) {
      const haystack = messageOf(() => parseOtpauthUri(secretUri)).toLowerCase();
      expect(haystack).not.toContain(secretUri.toLowerCase());
      const needle = SEED.toLowerCase();
      for (let start = 0; start + 4 <= needle.length; start += 1) {
        expect(haystack).not.toContain(needle.slice(start, start + 4));
      }
    }
  });
});

describe('writing a link back', () => {
  const secretOf = (): SecretBytes => SecretBytes.adopt(decodeBase32(SEED));

  it('round-trips through the parser unchanged', () => {
    const secret = secretOf();
    let uri: string;
    try {
      uri = buildOtpauthSecretUri({
        parameters: {
          algorithm: 'SHA256',
          digits: 8,
          periodSeconds: 60,
          issuer: 'Big Corp',
          account: 'ada@example.com',
        },
        secret,
      });
    } finally {
      secret.destroy();
    }

    expect(uri).toBe(
      `otpauth://totp/Big%20Corp:ada%40example.com?secret=${SEED}&issuer=Big%20Corp&algorithm=SHA256&digits=8&period=60`
    );

    withParsed(uri, (p) => {
      expect(p.parameters).toEqual({
        algorithm: 'SHA256',
        digits: 8,
        periodSeconds: 60,
        issuer: 'Big Corp',
        account: 'ada@example.com',
      });
      expect(seedHexOf(p)).toBe(SEED_HEX);
    });
  });

  it('writes a space as %20, never as +', () => {
    const secret = secretOf();
    try {
      const uri = buildOtpauthSecretUri({
        parameters: {
          algorithm: 'SHA1',
          digits: 6,
          periodSeconds: 30,
          issuer: 'Big Corp',
          account: 'ada',
        },
        secret,
      });
      // Form encoding would produce "Big+Corp", which a strict reader shows verbatim.
      expect(uri).not.toContain('+');
      expect(uri).toContain('issuer=Big%20Corp');
    } finally {
      secret.destroy();
    }
  });

  it('omits the issuer entirely when there is none', () => {
    const secret = secretOf();
    try {
      const uri = buildOtpauthSecretUri({
        parameters: {
          algorithm: 'SHA1',
          digits: 6,
          periodSeconds: 30,
          issuer: null,
          account: 'ada',
        },
        secret,
      });
      expect(uri).toBe(`otpauth://totp/ada?secret=${SEED}&algorithm=SHA1&digits=6&period=30`);
    } finally {
      secret.destroy();
    }
  });
});

describe('isOtpauthUri', () => {
  it.each([
    [`otpauth://totp/a?secret=${SEED}`, true],
    [`  OtpAuth://totp/a?secret=${SEED}  `, true],
    [SEED, false],
    ['', false],
    ['https://example.com', false],
  ])('classifies %j as %s', (value, expected) => {
    expect(isOtpauthUri(value)).toBe(expected);
  });
});
