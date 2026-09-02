// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { decodeBase32, decodeBase32Secret, encodeBase32 } from './base32.js';
import { TotpError } from './errors.js';

/**
 * The codec is tested harder than the RFC requires, because it is the only place a wrong
 * answer is silent. Everything downstream of a mis-decoded seed still works perfectly — it
 * just produces the wrong six digits forever.
 */

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const ascii = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'ascii'));

/** The message a thrown `TotpError` carried, for the "never echo the input" checks. */
function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TotpError);
    return (error as TotpError).message;
  }
  throw new Error('expected the call to throw, but it returned');
}

describe('RFC 4648 §10 test vectors', () => {
  // The published vectors, which is what makes this an implementation of the standard
  // rather than something that merely agrees with itself.
  const VECTORS: readonly [string, string][] = [
    ['f', 'MY======'],
    ['fo', 'MZXQ===='],
    ['foo', 'MZXW6==='],
    ['foob', 'MZXW6YQ='],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI======'],
  ];

  it.each(VECTORS)('encodes %j as %j, padded', (plain, encoded) => {
    expect(encodeBase32(ascii(plain), { pad: true })).toBe(encoded);
  });

  it.each(VECTORS)('decodes the padded encoding of %j back to %j', (plain, encoded) => {
    expect(hex(decodeBase32(encoded))).toBe(Buffer.from(plain, 'ascii').toString('hex'));
  });

  it.each(VECTORS)('decodes the unpadded encoding of %j back to %j', (plain, encoded) => {
    expect(hex(decodeBase32(encoded.replace(/=+$/, '')))).toBe(
      Buffer.from(plain, 'ascii').toString('hex')
    );
  });

  it('encodes unpadded by default, which is the form every authenticator emits', () => {
    expect(encodeBase32(ascii('foobar'))).toBe('MZXW6YTBOI');
  });
});

describe('real-world seeds', () => {
  // The seed used throughout this project's import fixtures and export tests.
  const SEED = 'JBSWY3DPEHPK3PXP';
  const SEED_HEX = '48656c6c6f21deadbeef';

  it('decodes the canonical example seed', () => {
    expect(hex(decodeBase32(SEED))).toBe(SEED_HEX);
  });

  it('encodes the RFC 6238 test key, so the vectors below can be expressed as a seed', () => {
    expect(encodeBase32(ascii('12345678901234567890'))).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it.each([
    ['lower case', 'jbswy3dpehpk3pxp'],
    ['mixed case', 'JbSwY3dPeHpK3pXp'],
    ['grouped with spaces, as enrolment pages print it', 'JBSW Y3DP EHPK 3PXP'],
    ['grouped with hyphens', 'JBSW-Y3DP-EHPK-3PXP'],
    ['a leading and trailing newline from a paste', '\nJBSWY3DPEHPK3PXP\n'],
    ['tabs from a spreadsheet cell', 'JBSW\tY3DP\tEHPK\t3PXP'],
    ['non-breaking spaces from a styled web page', 'JBSW Y3DP EHPK 3PXP'],
  ])('accepts a seed %s', (_description, input) => {
    expect(hex(decodeBase32(input))).toBe(SEED_HEX);
  });

  it('accepts the same seed with and without padding, and gets the same key', () => {
    // 26 characters is 130 bits: 16 whole bytes with 2 spare bits, so it pads out to 32.
    // The final character is one whose low two bits are zero, because anything else would
    // be a non-canonical encoding that this decoder refuses on purpose.
    const unpadded = 'JBSWY3DPEHPK3PXPJBSWY3DPEA';
    expect(hex(decodeBase32(unpadded))).toBe(hex(decodeBase32(`${unpadded}======`)));
  });

  it('returns key material wrapped as SecretBytes, not a bare buffer', () => {
    const secret = decodeBase32Secret(SEED);
    try {
      expect(secret.length).toBe(10);
      expect(secret.use((bytes) => hex(bytes))).toBe(SEED_HEX);
      // The wrapper is the point: a seed must not be able to reach a log by accident.
      expect(String(secret)).not.toContain('Hello');
      expect(JSON.stringify({ secret })).not.toContain('deadbeef');
    } finally {
      secret.destroy();
    }
  });

  it('round-trips arbitrary key lengths', () => {
    for (let length = 1; length <= 64; length += 1) {
      const bytes = Uint8Array.from({ length }, (_value, index) => (index * 37 + 11) & 0xff);
      expect(hex(decodeBase32(encodeBase32(bytes)))).toBe(hex(bytes));
      expect(hex(decodeBase32(encodeBase32(bytes, { pad: true })))).toBe(hex(bytes));
    }
  });
});

describe('what is rejected', () => {
  it.each([
    ['empty', ''],
    ['only separators', '  -- \t '],
    ['only padding', '========'],
    ['a digit outside the alphabet (0)', 'JBSWY3DP0HPK3PXP'],
    ['a digit outside the alphabet (1)', 'JBSWY3DP1HPK3PXP'],
    ['a digit outside the alphabet (8)', 'JBSWY3DP8HPK3PXP'],
    ['a digit outside the alphabet (9)', 'JBSWY3DP9HPK3PXP'],
    ['punctuation', 'JBSWY3DP!HPK3PXP'],
    ['a base64-only character', 'JBSWY3DP+HPK3PXP'],
    ['padding in the middle', 'JBSW=Y3DPEHPK3PXP'],
    ['padding that does not complete a group', 'MY='],
    ['an impossible length (1 over a group)', 'MZXW6YTBO'],
    ['an impossible length (3 over a group)', 'MZX'],
    ['an impossible length (6 over a group)', 'MZXW6Y'],
    ['non-zero bits in the final character', 'MZ'],
  ])('rejects %s', (_description, input) => {
    expect(() => decodeBase32(input)).toThrow(TotpError);
    try {
      decodeBase32(input);
    } catch (error) {
      expect((error as TotpError).code).toBe('INVALID_SEED');
    }
  });

  it('will not silently repair the 0/O and 1/L confusions a printed seed invites', () => {
    // The classic transcription mistake, and the reason a forgiving decoder is dangerous:
    // '0' and '1' are outside the alphabet while 'O' and 'L' are inside it, so "helpfully"
    // mapping one onto the other would turn a typo into a perfectly valid — and completely
    // different — key. Both are refused instead.
    expect(() => decodeBase32('JBSWY3DP0HPK3PXP')).toThrow(TotpError);
    expect(() => decodeBase32('JBSWY3DP1HPK3PXP')).toThrow(TotpError);

    // Proof the repair really would have been silent: the "repaired" strings decode without
    // complaint, and to two different keys, neither of which is the one that was printed.
    expect(hex(decodeBase32('JBSWY3DPOHPK3PXP'))).not.toBe(hex(decodeBase32('JBSWY3DPLHPK3PXP')));
  });

  it('names the position of the offending character, so the user can find it', () => {
    expect(messageOf(() => decodeBase32('JBSWY3DP0HPK3PXP'))).toContain('character 9');
    // Positions count data characters after separators are removed, which is how the value
    // is displayed.
    expect(messageOf(() => decodeBase32('JBSW Y3DP 0HPK 3PXP'))).toContain('character 9');
  });
});

describe('an error never carries the seed', () => {
  const BAD_SEEDS = [
    'JBSWY3DP0HPK3PXP',
    'MFRGGZDFMZTWQ2LK!NRWQ',
    'JBSW=Y3DPEHPK3PXP',
    'MZ',
    'MZX',
    'MY=',
    'NBUWY3DP05XXE3DE',
    '========',
  ];

  it.each(BAD_SEEDS)('does not echo %j, whole or in fragments', (seed) => {
    const message = messageOf(() => decodeBase32(seed));
    const haystack = message.toLowerCase();
    const needle = seed.toLowerCase();

    expect(haystack).not.toContain(needle);
    // Fragments matter as much as the whole: four characters of a seed is twenty bits of it.
    for (let start = 0; start + 4 <= needle.length; start += 1) {
      expect(haystack).not.toContain(needle.slice(start, start + 4));
    }
  });
});
