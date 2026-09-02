// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { passwordRange } from './hash.js';
import { MAX_RANGE_BODY_BYTES, parseRangeBody } from './range.js';

/**
 * Tests for the range parser.
 *
 * The assertion that matters more than all the others: **a body we cannot read produces
 * `malformed`, never a count of zero.** Every malformed case below is checked for that
 * explicitly rather than for "not the count we wanted", because the bug this file exists to
 * prevent is the one where a captive portal's login page is reported to the user as "not
 * found in any breach".
 */

const { suffix: PASSWORD_SUFFIX } = passwordRange('password');

/**
 * A 35-character hex suffix built from a repeated character.
 *
 * Constructed rather than typed out: a literal that is 34 characters long by accident would
 * make a test pass for the wrong reason — the parser would reject it as malformed and the
 * assertion "this is not a match" would still hold.
 */
const suffixOf = (character: string): string => character.repeat(35);

/** Padding rows: suffixes with a count of 0, exactly as the service sends them. */
const PADDING = [`${suffixOf('0')}:0`, `${suffixOf('F')}:0`];

function body(...lines: readonly string[]): string {
  return [...lines, ...PADDING].join('\r\n');
}

describe('parseRangeBody — finding a suffix', () => {
  it('returns the count for a suffix that is present', () => {
    const parsed = parseRangeBody(body(`${PASSWORD_SUFFIX}:12345`), PASSWORD_SUFFIX);
    expect(parsed).toEqual({ kind: 'ok', count: 12345, entryCount: 3 });
  });

  it('returns a count of zero when the suffix is genuinely absent', () => {
    const parsed = parseRangeBody(body(`${suffixOf('1')}:9`), PASSWORD_SUFFIX);
    expect(parsed).toEqual({ kind: 'ok', count: 0, entryCount: 3 });
  });

  it('counts every entry it read, padding included', () => {
    const parsed = parseRangeBody(
      body(`${PASSWORD_SUFFIX}:1`, `${suffixOf('2')}:2`),
      PASSWORD_SUFFIX
    );
    expect(parsed).toMatchObject({ entryCount: 4 });
  });

  it('tolerates a body with no trailing newline and one with several', () => {
    const line = `${PASSWORD_SUFFIX}:7`;
    expect(parseRangeBody(line, PASSWORD_SUFFIX)).toMatchObject({ count: 7 });
    expect(parseRangeBody(`${line}\n\n\n`, PASSWORD_SUFFIX)).toMatchObject({ count: 7 });
    expect(parseRangeBody(`\n${line}\r\n`, PASSWORD_SUFFIX)).toMatchObject({ count: 7 });
  });
});

describe('parseRangeBody — case-insensitivity', () => {
  /**
   * The service answers in upper case today. Depending on that is an undocumented
   * dependency on a formatting detail, and getting it wrong turns a real breach into a
   * silent "safe" — the worst direction available.
   */
  it('matches a lower-case body against an upper-case suffix', () => {
    const parsed = parseRangeBody(body(`${PASSWORD_SUFFIX.toLowerCase()}:42`), PASSWORD_SUFFIX);
    expect(parsed).toMatchObject({ kind: 'ok', count: 42 });
  });

  it('matches an upper-case body against a lower-case suffix', () => {
    const parsed = parseRangeBody(body(`${PASSWORD_SUFFIX}:42`), PASSWORD_SUFFIX.toLowerCase());
    expect(parsed).toMatchObject({ kind: 'ok', count: 42 });
  });

  it('matches a mixed-case body against a mixed-case suffix', () => {
    // `Array.from` rather than a spread: the suffix is hex and cannot contain a surrogate
    // pair, but spreading a string is banned outright by lint precisely because the day
    // someone reuses this idiom on a password it would split an emoji in half.
    const mixed = Array.from(PASSWORD_SUFFIX, (character, index) =>
      index % 2 === 0 ? character.toLowerCase() : character
    ).join('');
    expect(parseRangeBody(body(`${mixed}:42`), mixed)).toMatchObject({ count: 42 });
  });
});

describe('parseRangeBody — padding', () => {
  /**
   * Padding rows carry a count of 0 and are not answers. If one ever collided with the
   * suffix being sought, treating it as a match would report a breach that does not exist;
   * treating `0` as "not present" is correct in both readings.
   */
  it('does not treat a padding row as a match', () => {
    const parsed = parseRangeBody(body(`${PASSWORD_SUFFIX}:0`), PASSWORD_SUFFIX);
    expect(parsed).toMatchObject({ kind: 'ok', count: 0 });
  });

  it('finds a real entry among hundreds of padding rows', () => {
    const padding = Array.from(
      { length: 800 },
      (_, index) => `${index.toString(16).toUpperCase().padStart(35, 'A')}:0`
    );
    const parsed = parseRangeBody([...padding, `${PASSWORD_SUFFIX}:3`].join('\n'), PASSWORD_SUFFIX);
    expect(parsed).toMatchObject({ kind: 'ok', count: 3, entryCount: 801 });
  });
});

describe('parseRangeBody — a body that is not a suffix list is never "safe"', () => {
  const notLists: Readonly<Record<string, string>> = {
    'an empty body': '',
    'a whitespace-only body': '   \r\n  \n',
    'an HTML error page': '<html><head><title>503</title></head><body>Try later</body></html>',
    'a captive-portal redirect page': 'Please sign in to the hotel network to continue.',
    'a JSON error object': '{"statusCode":429,"message":"Rate limit exceeded"}',
    'a suffix of the wrong length': '1E4C9B93F3F0682250B6CF8331B7EE68FD:1',
    'an entry with no count': `${PASSWORD_SUFFIX}:`,
    'an entry with a non-numeric count': `${PASSWORD_SUFFIX}:many`,
    'an entry with a negative count': `${PASSWORD_SUFFIX}:-4`,
    'a count of absurd length': `${PASSWORD_SUFFIX}:${'9'.repeat(40)}`,
    'a non-hex suffix': `${suffixOf('Z')}:1`,
    'an entry with an extra field': `${PASSWORD_SUFFIX}:1:1`,
  };

  for (const [description, malformed] of Object.entries(notLists)) {
    it(`reports ${description} as malformed, not as a count of zero`, () => {
      const parsed = parseRangeBody(malformed, PASSWORD_SUFFIX);
      expect(parsed.kind).toBe('malformed');
      expect(parsed).not.toHaveProperty('count');
    });
  }

  /**
   * Strictness is the deliberate choice here. The format is machine-generated and uniform,
   * so one line that does not parse means the body is not what it claims to be — and
   * "mostly a suffix list" is not a category we are willing to answer questions from.
   */
  it('rejects the whole body when a single line among good ones is junk', () => {
    const parsed = parseRangeBody(
      [`${PASSWORD_SUFFIX}:5`, '<!-- injected -->', `${suffixOf('1')}:1`].join('\n'),
      PASSWORD_SUFFIX
    );
    expect(parsed).toEqual({ kind: 'malformed', fault: 'unparseableLine' });
  });

  it('rejects a body truncated mid-entry rather than reading what survived', () => {
    const parsed = parseRangeBody(`${PASSWORD_SUFFIX}:5\n1111111111111111`, PASSWORD_SUFFIX);
    expect(parsed).toEqual({ kind: 'malformed', fault: 'unparseableLine' });
  });

  it('rejects a body past the size cap without reading it', () => {
    const oversized = `${'A'.repeat(35)}:1\n`.repeat(Math.ceil(MAX_RANGE_BODY_BYTES / 38) + 10);
    expect(oversized.length).toBeGreaterThan(MAX_RANGE_BODY_BYTES);
    expect(parseRangeBody(oversized, PASSWORD_SUFFIX)).toEqual({
      kind: 'malformed',
      fault: 'oversized',
    });
  });

  it('names the fault without ever quoting the body or the suffix', () => {
    const parsed = parseRangeBody('<html>SECRET_IN_THE_BODY</html>', PASSWORD_SUFFIX);
    const serialised = JSON.stringify(parsed);
    expect(serialised).not.toContain('SECRET_IN_THE_BODY');
    expect(serialised).not.toContain(PASSWORD_SUFFIX);
  });
});

describe('parseRangeBody — a duplicated entry resolves upwards', () => {
  /**
   * Two counts for one suffix should be impossible, and would mean the body is already
   * suspect. Between the two readings, the one that tells the user to change their password
   * is the one that cannot hurt them.
   */
  it('takes the largest count when a suffix appears twice', () => {
    const parsed = parseRangeBody(
      body(`${PASSWORD_SUFFIX}:2`, `${PASSWORD_SUFFIX}:900`, `${PASSWORD_SUFFIX}:5`),
      PASSWORD_SUFFIX
    );
    expect(parsed).toMatchObject({ count: 900 });
  });

  it('does not let a padding-shaped duplicate erase a real count', () => {
    const parsed = parseRangeBody(
      body(`${PASSWORD_SUFFIX}:31`, `${PASSWORD_SUFFIX}:0`),
      PASSWORD_SUFFIX
    );
    expect(parsed).toMatchObject({ count: 31 });
  });
});
