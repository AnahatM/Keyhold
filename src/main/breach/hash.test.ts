// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { passwordRange, rangePrefix, RANGE_PREFIX_LENGTH, RANGE_SUFFIX_LENGTH } from './hash.js';

/**
 * Tests for the range split — the boundary that decides what is transmitted.
 *
 * The published vector for this API is `password` → `5BAA6`, and it is asserted twice
 * here on purpose: once against the literal, and once against a SHA-1 computed
 * independently inside the test. Asserting only against the literal proves that someone
 * typed the right constant; asserting only against a recomputation proves the code agrees
 * with itself. Both together prove it agrees with the corpus.
 */

/** Recomputed in the test rather than imported, so the test is not the code under test. */
function independentSha1(value: string): string {
  return createHash('sha1').update(Buffer.from(value, 'utf8')).digest('hex').toUpperCase();
}

const SAMPLES = [
  'password',
  '123456',
  'P@ssw0rd',
  'correct horse battery staple',
  'Tr0ub4dor&3',
  'ünïcøde-pässwörd',
  '🔐🔐🔐',
  ' leading and trailing ',
  '',
];

describe('rangePrefix', () => {
  it('gives the published vector for "password"', () => {
    expect(rangePrefix('password')).toBe('5BAA6');
  });

  it('agrees with an independently computed SHA-1, for every sample', () => {
    for (const sample of SAMPLES) {
      expect(rangePrefix(sample), sample).toBe(independentSha1(sample).slice(0, 5));
    }
  });

  it('is always five upper-case hex characters', () => {
    for (const sample of SAMPLES) {
      expect(rangePrefix(sample), sample).toMatch(/^[0-9A-F]{5}$/);
    }
  });
});

describe('passwordRange', () => {
  it('splits the published vector at exactly five characters', () => {
    expect(passwordRange('password')).toEqual({
      prefix: '5BAA6',
      suffix: '1E4C9B93F3F0682250B6CF8331B7EE68FD8',
    });
  });

  it('reconstitutes the full digest, so nothing is lost or duplicated at the split', () => {
    for (const sample of SAMPLES) {
      const { prefix, suffix } = passwordRange(sample);
      expect(prefix + suffix, sample).toBe(independentSha1(sample));
    }
  });

  it('holds the documented lengths — 5 sent, 35 retained, 40 in total', () => {
    expect(RANGE_PREFIX_LENGTH + RANGE_SUFFIX_LENGTH).toBe(40);
    for (const sample of SAMPLES) {
      const { prefix, suffix } = passwordRange(sample);
      expect(prefix, sample).toHaveLength(RANGE_PREFIX_LENGTH);
      expect(suffix, sample).toHaveLength(RANGE_SUFFIX_LENGTH);
      expect(suffix, sample).toMatch(/^[0-9A-F]{35}$/);
    }
  });

  it('agrees with rangePrefix, so the two entry points cannot drift', () => {
    for (const sample of SAMPLES) {
      expect(passwordRange(sample).prefix, sample).toBe(rangePrefix(sample));
    }
  });

  /**
   * Passwords are case-sensitive and the corpus is indexed by exact bytes. If case folding
   * ever crept in here — and "normalise it, hex is case-insensitive anyway" is a plausible
   * mistake to make in this file — `Hunter2` would be looked up as `hunter2` and reported
   * against the wrong entry.
   */
  it('treats a password as case-sensitive', () => {
    expect(passwordRange('hunter2')).not.toEqual(passwordRange('Hunter2'));
  });

  /**
   * The corpus is built over UTF-8 bytes. A password with an accent in it only matches if
   * we encode it the same way, and this is the one class of password where a silent
   * encoding change would go unnoticed for years.
   */
  it('hashes the UTF-8 encoding, not UTF-16 or latin1', () => {
    const value = 'pässwörd';
    const utf8 = createHash('sha1').update(Buffer.from(value, 'utf8')).digest('hex').toUpperCase();
    const latin1 = createHash('sha1')
      .update(Buffer.from(value, 'latin1'))
      .digest('hex')
      .toUpperCase();

    expect(utf8).not.toBe(latin1);
    const { prefix, suffix } = passwordRange(value);
    expect(prefix + suffix).toBe(utf8);
  });

  it('handles the empty string without throwing, since callers may pass one', () => {
    expect(passwordRange('')).toEqual({
      prefix: 'DA39A',
      suffix: '3EE5E6B4B0D3255BFEF95601890AFD80709',
    });
  });
});
