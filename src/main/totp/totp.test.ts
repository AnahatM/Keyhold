// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { TOTP_DEFAULTS, totpProgress, totpRemainingMs } from '@shared/model/totp.js';
import { SecretBytes } from '../crypto/secret.js';
import { TotpError } from './errors.js';
import {
  generateTotpSecretCode,
  hmacOtpSecretCode,
  totpWindowAt,
  verifyTotpSecretCode,
} from './totp.js';
import type { TotpAlgorithm, TotpParameters } from '@shared/model/totp.js';

/**
 * The published vectors are the whole point of this file.
 *
 * TOTP has no error detection: a broken implementation and a correct one both emit six
 * digits at the right moment, and the only way to tell them apart is to check against numbers
 * somebody else computed. So the RFC 4226 and RFC 6238 appendix vectors are reproduced here
 * exactly, and if they ever stop passing, nothing else in this module is trustworthy.
 */

const secretOf = (ascii: string): SecretBytes =>
  SecretBytes.copyOf(Uint8Array.from(Buffer.from(ascii, 'ascii')));

function parametersFor(
  algorithm: TotpAlgorithm,
  digits: number,
  periodSeconds = 30
): TotpParameters {
  return { algorithm, digits, periodSeconds, issuer: null, account: null };
}

// ── RFC 4226 Appendix D: the HOTP vectors ────────────────────────────────────

describe('RFC 4226 HOTP test vectors', () => {
  // Secret "12345678901234567890", counters 0 through 9, 6 digits, HMAC-SHA1.
  const EXPECTED = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];

  it('reproduces every counter in the appendix', () => {
    const secret = secretOf('12345678901234567890');
    try {
      const actual = EXPECTED.map((_code, counter) =>
        hmacOtpSecretCode(secret, counter, 'SHA1', 6)
      );
      expect(actual).toEqual(EXPECTED);
    } finally {
      secret.destroy();
    }
  });
});

// ── RFC 6238 Appendix B: the TOTP vectors ────────────────────────────────────

/**
 * The three keys the RFC uses.
 *
 * They are not the same key at three lengths by accident: HMAC block sizes differ, so a
 * SHA-512 vector computed with the 20-byte SHA-1 key would exercise a different code path in
 * the key-padding step and prove less. The RFC repeats the digits "1234567890" out to the
 * block size of each hash, and that is what is reproduced here.
 */
const KEYS: Readonly<Record<TotpAlgorithm, string>> = {
  SHA1: '12345678901234567890',
  SHA256: '12345678901234567890123456789012',
  SHA512: '1234567890123456789012345678901234567890123456789012345678901234',
};

/** [ time in seconds, SHA1, SHA256, SHA512 ] — 8 digits, 30-second period, T0 = 0. */
const TOTP_VECTORS: readonly [number, string, string, string][] = [
  [59, '94287082', '46119246', '90693936'],
  [1_111_111_109, '07081804', '68084774', '25091201'],
  [1_111_111_111, '14050471', '67062674', '99943326'],
  [1_234_567_890, '89005924', '91819424', '93441116'],
  [2_000_000_000, '69279037', '90698825', '38618901'],
  [20_000_000_000, '65353130', '77737706', '47863826'],
];

describe('RFC 6238 TOTP test vectors', () => {
  const COLUMN: Readonly<Record<TotpAlgorithm, 1 | 2 | 3>> = { SHA1: 1, SHA256: 2, SHA512: 3 };

  for (const algorithm of ['SHA1', 'SHA256', 'SHA512'] as const) {
    it(`reproduces every ${algorithm} vector`, () => {
      const secret = secretOf(KEYS[algorithm]);
      try {
        for (const vector of TOTP_VECTORS) {
          const seconds = vector[0];
          const expected = vector[COLUMN[algorithm]];
          // Seconds → milliseconds at the call site, because `now` is a millisecond instant
          // everywhere in this codebase and the RFC's table is in seconds.
          const result = generateTotpSecretCode(
            secret,
            parametersFor(algorithm, 8),
            seconds * 1000
          );
          expect(`${algorithm} @ T=${seconds}: ${result.secretCode}`).toBe(
            `${algorithm} @ T=${seconds}: ${expected}`
          );
        }
      } finally {
        secret.destroy();
      }
    });
  }

  it('produces the last six digits of the same vector when six digits are asked for', () => {
    // Truncation is a modulo, so a 6-digit code is the 8-digit code's low six digits. Worth
    // asserting: it is the cheapest way to show the digit count is applied to the same
    // truncated integer rather than to a separately computed one.
    const secret = secretOf(KEYS.SHA1);
    try {
      const eight = generateTotpSecretCode(secret, parametersFor('SHA1', 8), 59_000);
      const six = generateTotpSecretCode(secret, parametersFor('SHA1', 6), 59_000);
      expect(six.secretCode).toBe(eight.secretCode.slice(-6));
      expect(six.secretCode).toBe('287082');
    } finally {
      secret.destroy();
    }
  });
});

// ── The window, and the instant a code rolls over ────────────────────────────

describe('the time window', () => {
  it('reports the step, and its absolute start and end', () => {
    const window = totpWindowAt(59_000, 30);
    expect(window).toEqual({
      counter: 1,
      startsAt: 30_000,
      expiresAt: 60_000,
      periodMs: 30_000,
    });
  });

  it('rolls over exactly at the boundary, not a millisecond either side', () => {
    // This is where off-by-one lives. `startsAt` is inclusive and `expiresAt` exclusive, so
    // the last millisecond of a step still belongs to it and the first of the next does not.
    expect(totpWindowAt(29_999, 30).counter).toBe(0);
    expect(totpWindowAt(30_000, 30).counter).toBe(1);
    expect(totpWindowAt(59_999, 30).counter).toBe(1);
    expect(totpWindowAt(60_000, 30).counter).toBe(2);
  });

  it('changes the code at exactly that instant', () => {
    const secret = secretOf(KEYS.SHA1);
    const parameters = parametersFor('SHA1', 8);
    try {
      const last = generateTotpSecretCode(secret, parameters, 59_999);
      const first = generateTotpSecretCode(secret, parameters, 60_000);
      expect(last.secretCode).toBe('94287082');
      expect(first.secretCode).not.toBe(last.secretCode);
      expect(first.window.startsAt).toBe(last.window.expiresAt);
    } finally {
      secret.destroy();
    }
  });

  it('honours a non-default period', () => {
    expect(totpWindowAt(59_000, 60)).toEqual({
      counter: 0,
      startsAt: 0,
      expiresAt: 60_000,
      periodMs: 60_000,
    });
    expect(totpWindowAt(60_000, 60).counter).toBe(1);
  });

  it('gives the renderer a countdown that stays right as time passes', () => {
    const window = totpWindowAt(35_000, 30);
    expect(totpRemainingMs(window, 35_000)).toBe(25_000);
    expect(totpRemainingMs(window, 59_999)).toBe(1);
    // Past the deadline reads as expired rather than as a negative countdown.
    expect(totpRemainingMs(window, 60_000)).toBe(0);
    expect(totpRemainingMs(window, 999_999)).toBe(0);
    expect(totpProgress(window, 30_000)).toBe(0);
    expect(totpProgress(window, 45_000)).toBe(0.5);
    expect(totpProgress(window, 60_000)).toBe(1);
  });

  it('uses the Key Uri Format defaults when nothing else is said', () => {
    expect(TOTP_DEFAULTS).toEqual({ algorithm: 'SHA1', digits: 6, periodSeconds: 30 });
  });
});

// ── Verification and clock skew ──────────────────────────────────────────────

describe('verification', () => {
  const parameters = parametersFor('SHA1', 8);
  const NOW = 1_111_111_111_000;

  it('accepts the code for this instant', () => {
    const secret = secretOf(KEYS.SHA1);
    try {
      expect(verifyTotpSecretCode(secret, parameters, '14050471', NOW)).toEqual({
        valid: true,
        skewSteps: 0,
      });
    } finally {
      secret.destroy();
    }
  });

  it('accepts one step either side, and says which one matched', () => {
    const secret = secretOf(KEYS.SHA1);
    try {
      const previous = generateTotpSecretCode(secret, parameters, NOW - 30_000).secretCode;
      const next = generateTotpSecretCode(secret, parameters, NOW + 30_000).secretCode;

      expect(verifyTotpSecretCode(secret, parameters, previous, NOW)).toEqual({
        valid: true,
        skewSteps: -1,
      });
      expect(verifyTotpSecretCode(secret, parameters, next, NOW)).toEqual({
        valid: true,
        skewSteps: 1,
      });
    } finally {
      secret.destroy();
    }
  });

  it('refuses two steps away, which is drift rather than skew', () => {
    const secret = secretOf(KEYS.SHA1);
    try {
      const stale = generateTotpSecretCode(secret, parameters, NOW - 60_000).secretCode;
      expect(verifyTotpSecretCode(secret, parameters, stale, NOW)).toEqual({
        valid: false,
        skewSteps: null,
      });
      // …unless the caller widens the window on purpose.
      expect(verifyTotpSecretCode(secret, parameters, stale, NOW, { skewSteps: 2 })).toEqual({
        valid: true,
        skewSteps: -2,
      });
    } finally {
      secret.destroy();
    }
  });

  it('can be told to accept this instant only', () => {
    const secret = secretOf(KEYS.SHA1);
    try {
      const previous = generateTotpSecretCode(secret, parameters, NOW - 30_000).secretCode;
      expect(verifyTotpSecretCode(secret, parameters, previous, NOW, { skewSteps: 0 })).toEqual({
        valid: false,
        skewSteps: null,
      });
    } finally {
      secret.destroy();
    }
  });

  it('never lets the skew window affect generation', () => {
    // The guarantee in prose: the generated code is the code for the step `now` is in, and
    // is not one of the neighbours the verifier would have accepted.
    const secret = secretOf(KEYS.SHA1);
    try {
      const current = generateTotpSecretCode(secret, parameters, NOW).secretCode;
      expect(current).toBe('14050471');
      expect(current).not.toBe(generateTotpSecretCode(secret, parameters, NOW - 30_000).secretCode);
      expect(current).not.toBe(generateTotpSecretCode(secret, parameters, NOW + 30_000).secretCode);
    } finally {
      secret.destroy();
    }
  });

  it('tolerates the grouping a human types', () => {
    const secret = secretOf(KEYS.SHA1);
    try {
      expect(verifyTotpSecretCode(secret, parameters, ' 1405 0471 ', NOW).valid).toBe(true);
      expect(verifyTotpSecretCode(secret, parameters, '1405-0471', NOW).valid).toBe(true);
    } finally {
      secret.destroy();
    }
  });

  it('rejects a wrong-length code without pretending it might have matched', () => {
    const secret = secretOf(KEYS.SHA1);
    try {
      expect(verifyTotpSecretCode(secret, parameters, '1405047', NOW)).toEqual({
        valid: false,
        skewSteps: null,
      });
      expect(verifyTotpSecretCode(secret, parameters, '', NOW).valid).toBe(false);
    } finally {
      secret.destroy();
    }
  });

  it('refuses an absurd skew window rather than looping over it', () => {
    const secret = secretOf(KEYS.SHA1);
    try {
      expect(() =>
        verifyTotpSecretCode(secret, parameters, '14050471', NOW, { skewSteps: 5000 })
      ).toThrow(TotpError);
      expect(() =>
        verifyTotpSecretCode(secret, parameters, '14050471', NOW, { skewSteps: -1 })
      ).toThrow(TotpError);
    } finally {
      secret.destroy();
    }
  });
});

// ── Parameter guards ─────────────────────────────────────────────────────────

describe('parameter guards', () => {
  const secret = (): SecretBytes => secretOf(KEYS.SHA1);

  it.each([
    ['a digit count below the RFC minimum', parametersFor('SHA1', 4)],
    ['a digit count past what truncation can fill', parametersFor('SHA1', 11)],
    ['a fractional digit count', parametersFor('SHA1', 6.5)],
    ['a zero period', parametersFor('SHA1', 6, 0)],
    ['a negative period', parametersFor('SHA1', 6, -30)],
    ['an absurd period', parametersFor('SHA1', 6, 999_999_999)],
  ])('rejects %s', (_description, parameters) => {
    const key = secret();
    try {
      expect(() => generateTotpSecretCode(key, parameters, 0)).toThrow(TotpError);
    } finally {
      key.destroy();
    }
  });

  it('rejects a time before the epoch rather than throwing from a buffer write', () => {
    const key = secret();
    try {
      expect(() => generateTotpSecretCode(key, parametersFor('SHA1', 6), -1000)).toThrow(TotpError);
    } finally {
      key.destroy();
    }
  });

  it('never puts the seed or the code in an error', () => {
    const key = secret();
    try {
      let message = '';
      try {
        generateTotpSecretCode(key, parametersFor('SHA1', 99), 59_000);
      } catch (error) {
        message = (error as TotpError).message;
      }
      expect(message).not.toBe('');
      expect(message.toLowerCase()).not.toContain('12345678901234567890');
      expect(message).not.toContain('94287082');
      expect(message).not.toContain('287082');
    } finally {
      key.destroy();
    }
  });
});
