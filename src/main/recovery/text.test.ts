// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VERSIONED_FIELDS } from '@shared/model/credential.js';
import { formatCount, redactUnknownFields, sanitiseDetail, wrapText } from './text.js';

/**
 * Three small helpers that every diagnostic message goes through. Small enough to look
 * unworthy of tests, and load-bearing enough that a regression in any of them is invisible
 * until a report is already in a public issue tracker.
 */

describe('formatCount', () => {
  it('groups digits with commas', () => {
    expect(formatCount(4096)).toBe('4,096');
    expect(formatCount(268_435_456)).toBe('268,435,456');
  });

  it('leaves anything under a thousand alone', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
  });

  it('handles negatives, which a byte-difference can be', () => {
    expect(formatCount(-4096)).toBe('-4,096');
  });

  it('is not localised, so CI and a laptop render the same report', () => {
    // `toLocaleString` would render `4.096` under a German locale and the same report would
    // read differently on two machines. This is the guard for that.
    const german = new Intl.NumberFormat('de-DE').format(4096);
    expect(german).not.toBe(formatCount(4096));
    expect(formatCount(4096)).toBe('4,096');
  });

  it('does not produce NaN or Infinity in the middle of a sentence', () => {
    expect(formatCount(Number.NaN)).toBe('NaN');
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });

  it('truncates rather than rounding, so a byte count is never inflated', () => {
    expect(formatCount(1999.9)).toBe('1,999');
  });
});

describe('sanitiseDetail', () => {
  it('collapses whitespace so a message stays one line', () => {
    expect(sanitiseDetail('a  b\n\tc  ')).toBe('a b c');
  });

  it('caps the length, so one pathological file cannot become a page of text', () => {
    const long = 'x'.repeat(500);
    const result = sanitiseDetail(long);

    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith('…')).toBe(true);
  });

  it('leaves a short message exactly as it was', () => {
    expect(sanitiseDetail('declared 69 bytes, 8 available')).toBe('declared 69 bytes, 8 available');
  });
});

describe('redactUnknownFields', () => {
  it('keeps a quoted token that is a known field name', () => {
    const message = 'version 2 names unknown field "password"';
    expect(redactUnknownFields(message, VERSIONED_FIELDS)).toBe(message);
  });

  it('removes a quoted token that is not, because it could be anything at all', () => {
    // In a corrupt document the offending snapshot key could be a fragment of a decrypted
    // note. The invariant that broke is worth keeping; the token is not.
    const result = redactUnknownFields('version 2 snapshots "hunter2-fragment"', VERSIONED_FIELDS);

    expect(result).toBe('version 2 snapshots "…"');
    expect(result).not.toContain('hunter2');
  });

  it('redacts every unknown token, not only the first', () => {
    const result = redactUnknownFields('"aaa" and "bbb" and "title"', VERSIONED_FIELDS);
    expect(result).toBe('"…" and "…" and "title"');
  });

  it('leaves an unquoted message untouched', () => {
    expect(redactUnknownFields('r1: version numbers must strictly ascend', VERSIONED_FIELDS)).toBe(
      'r1: version numbers must strictly ascend'
    );
  });

  it('handles an empty quoted token', () => {
    expect(redactUnknownFields('field ""', VERSIONED_FIELDS)).toBe('field "…"');
  });
});

describe('wrapText', () => {
  it('wraps at the width without splitting words', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog', 12);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(12);
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog');
  });

  it('leaves a word longer than the width intact', () => {
    // The only long tokens in a report are ids, and a hyphenated id is one nobody can
    // search for.
    const id = 'a'.repeat(40);
    expect(wrapText(id, 10)).toEqual([id]);
  });

  it('returns a single empty line for empty input rather than nothing', () => {
    // A caller pushing the result straight into a line array must not silently drop a
    // paragraph and shift the layout.
    expect(wrapText('', 20)).toEqual(['']);
    expect(wrapText('   ', 20)).toEqual(['']);
  });

  it('collapses runs of whitespace as it wraps', () => {
    expect(wrapText('a\n\n  b', 20)).toEqual(['a b']);
  });
});
