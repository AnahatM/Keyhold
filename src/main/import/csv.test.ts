// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  headerContains,
  headerMatchesAny,
  parseCsvRows,
  parseCsvTable,
  readHeaderKeys,
  stripBom,
} from './csv.js';

/**
 * The CSV reader's tests.
 *
 * **A bug here is a bug in ten importers at once**, which is why this file is the longest in
 * the import engine. Every parser except the Bitwarden JSON one reaches the user's data
 * through `parseCsvTable`, so a mishandled quote or a swallowed BOM is not one broken format,
 * it is every format, and the symptom — blank titles, shifted columns — looks like a mapping
 * bug rather than a parsing one.
 *
 * Fault injections performed against this file (see the testing policy doc):
 *
 *  1. `stripBom` made a no-op (`return text`). **This injection found a real hole on its
 *     first run.** Only the direct `stripBom` unit test failed — the end-to-end table
 *     assertion kept passing, because `normaliseColumnKey` in `@shared/model/import` also
 *     trims a leading BOM and was quietly covering for the reader. Two defences are fine; a
 *     test that cannot tell which of them is working is not. So "does not let a BOM reach
 *     the first cell of the first row" was added against the raw reader, and on re-injection
 *     two tests failed as they should.
 *  2. The end-of-input flush condition reduced to `if (field !== '')`. Caught: "reads a final
 *     row that has no trailing newline" failed on a row ending in an empty cell — exactly the
 *     shape a trailing `,` produces, which is common in Chromium exports.
 *
 * Both were restored immediately, and all 31 tests pass again.
 */

describe('BOM handling', () => {
  it('strips a leading BOM and leaves the rest of the text alone', () => {
    expect(stripBom('\uFEFFname,url')).toBe('name,url');
    expect(stripBom('name,url')).toBe('name,url');
  });

  it('does not strip a BOM that is not at the start — there it is data', () => {
    expect(stripBom('name\uFEFF,url')).toBe('name\uFEFF,url');
  });

  it('does not let a BOM reach the first cell of the first row', () => {
    // Asserted on the raw reader, not on the table. `normaliseColumnKey` also trims a leading
    // BOM, so a table-level assertion alone kept passing when the reader's stripping was
    // removed — which is exactly what fault injection 1 exposed. Two defences are fine; a test
    // that cannot tell which of them is working is not.
    const { rows } = parseCsvRows('\uFEFFname,url\n');
    expect(rows[0]?.cells).toEqual(['name', 'url']);
  });

  it('keeps the first column name usable when the file starts with a BOM', () => {
    // The end-to-end statement. An unstripped BOM does not corrupt the values, it corrupts the *first
    // column name* — so every lookup of `name` misses and every title imports blank, with no
    // error anywhere.
    const { table } = parseCsvTable('\uFEFFname,url\nExample,https://example.com\n');
    expect(table.keys).toEqual(['name', 'url']);
    expect(table.rows[0]?.values.get('name')).toBe('Example');
  });
});

describe('quoting', () => {
  it('keeps a comma inside a quoted field', () => {
    const { rows } = parseCsvRows('a,"one, two",c\n');
    expect(rows[0]?.cells).toEqual(['a', 'one, two', 'c']);
  });

  it('keeps a newline inside a quoted field', () => {
    const { rows } = parseCsvRows('a,"line one\nline two",c\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cells[1]).toBe('line one\nline two');
  });

  it('normalises a CRLF inside a quoted field to a plain newline', () => {
    // A note that round-trips through Windows should not acquire stray carriage returns in
    // the vault; they show up as a blank line in every UI that renders the note.
    const { rows } = parseCsvRows('a,"line one\r\nline two"\r\n');
    expect(rows[0]?.cells[1]).toBe('line one\nline two');
  });

  it('unescapes a doubled quote', () => {
    const { rows } = parseCsvRows('"she said ""hello""",b\n');
    expect(rows[0]?.cells[0]).toBe('she said "hello"');
  });

  it('treats a quote in the middle of an unquoted field as literal text', () => {
    // Excel writes this, and so do hand-edited files. Treating it as an opening quote would
    // swallow the rest of the file into one cell.
    const { rows } = parseCsvRows('3" pipe,b\n');
    expect(rows[0]?.cells).toEqual(['3" pipe', 'b']);
  });

  it('distinguishes an empty quoted field from an empty unquoted one only by reporting neither', () => {
    const { rows } = parseCsvRows('"",\n');
    expect(rows[0]?.cells).toEqual(['', '']);
  });

  it('salvages the last row and reports an unterminated quote instead of throwing', () => {
    const document = parseCsvRows('a,b\n"unclosed,c\n');
    expect(document.unterminatedQuote).toBe(true);
    expect(document.rows[1]?.cells[0]).toBe('unclosed,c\n');
  });
});

describe('line endings', () => {
  it('reads LF, CRLF and a mixture of both', () => {
    const { rows } = parseCsvRows('a,b\r\nc,d\ne,f\r\ng,h');
    expect(rows.map((row) => row.cells)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
      ['g', 'h'],
    ]);
  });

  it('reads a lone CR as a row separator', () => {
    const { rows } = parseCsvRows('a,b\rc,d');
    expect(rows).toHaveLength(2);
  });

  it('does not invent a phantom row from a trailing newline', () => {
    expect(parseCsvRows('a,b\nc,d\n').rows).toHaveLength(2);
    expect(parseCsvRows('a,b\nc,d\r\n').rows).toHaveLength(2);
  });

  it('reads a final row that has no trailing newline', () => {
    expect(parseCsvRows('a,b\nc,d').rows).toHaveLength(2);
    // A row ending in an empty cell is the case a naive flush condition loses.
    expect(parseCsvRows('a,b\nc,').rows[1]?.cells).toEqual(['c', '']);
  });

  it('counts the line of each row, including lines consumed inside quotes', () => {
    const { rows } = parseCsvRows('h1,h2\n"multi\nline",b\nlast,row\n');
    expect(rows.map((row) => row.line)).toEqual([1, 2, 4]);
  });
});

describe('the table view', () => {
  it('trims and lower-cases header names for lookup while keeping them verbatim for display', () => {
    const { table } = parseCsvTable(' Login Name , URL \nada,https://example.com\n');
    expect(table.columns).toEqual(['Login Name', 'URL']);
    expect(table.keys).toEqual(['login name', 'url']);
  });

  it('returns an empty table for an empty file', () => {
    const { table } = parseCsvTable('');
    expect(table.columns).toEqual([]);
    expect(table.rows).toEqual([]);
  });

  it('returns a header and no rows for a header-only file', () => {
    const { table, warnings } = parseCsvTable('name,url\n');
    expect(table.columns).toEqual(['name', 'url']);
    expect(table.rows).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('skips blank lines without calling them damage', () => {
    const { table, warnings } = parseCsvTable('name,url\n\nExample,https://example.com\n\n');
    expect(table.rows).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('warns about a short row rather than shifting its values', () => {
    const { table, warnings } = parseCsvTable('a,b,c\n1,2\n');
    expect(table.rows[0]?.values.get('a')).toBe('1');
    expect(table.rows[0]?.values.get('b')).toBe('2');
    // Absent, not empty-string-at-the-wrong-index. The alternative silently moves data.
    expect(table.rows[0]?.values.has('c')).toBe(false);
    expect(warnings.map((warning) => warning.kind)).toEqual(['ragged-row']);
    expect(warnings[0]?.line).toBe(2);
  });

  it('warns about a long row and keeps the extra cells addressable', () => {
    const { table, warnings } = parseCsvTable('a,b\n1,2,3\n');
    expect(table.rows[0]?.cells).toEqual(['1', '2', '3']);
    expect(warnings.map((warning) => warning.kind)).toEqual(['ragged-row']);
  });

  it('uses the first of two identically named columns and says so', () => {
    const { table, warnings } = parseCsvTable('url,url\nfirst,second\n');
    expect(table.rows[0]?.values.get('url')).toBe('first');
    expect(warnings[0]?.kind).toBe('format');
    expect(warnings[0]?.column).toBe('url');
  });

  it('reports an unterminated quote as a format warning', () => {
    const { warnings } = parseCsvTable('a,b\n"oops,c\n');
    expect(warnings.some((warning) => warning.kind === 'format')).toBe(true);
  });
});

describe('header inspection', () => {
  it('reads only the first row, whatever follows it', () => {
    expect(readHeaderKeys('Name,URL\nrow,two\nrow,three\n')).toEqual(['name', 'url']);
  });

  it('sees through a BOM', () => {
    expect(readHeaderKeys('\uFEFFname,url\n')).toEqual(['name', 'url']);
  });

  it('returns nothing for an empty file rather than throwing', () => {
    expect(readHeaderKeys('')).toEqual([]);
  });

  it('matches an exact column set regardless of order', () => {
    expect(headerMatchesAny(['url', 'name'], [['name', 'url']])).toBe(true);
    // A superset must not match — this is what stops 1Password's export claiming Safari's.
    expect(headerMatchesAny(['name', 'url', 'extra'], [['name', 'url']])).toBe(false);
  });

  it('matches a required subset and honours the forbidden list', () => {
    expect(headerContains(['a', 'b', 'c'], ['a', 'b'])).toBe(true);
    expect(headerContains(['a', 'b', 'c'], ['a', 'b'], ['c'])).toBe(false);
  });
});

describe('delimiters', () => {
  it('reads a tab-separated file when told to', () => {
    const { rows } = parseCsvRows('a\tb\n1\t2\n', { delimiter: '\t' });
    expect(rows[1]?.cells).toEqual(['1', '2']);
  });

  it('stops early when a row limit is given', () => {
    const { rows } = parseCsvRows('a,b\n1,2\n3,4\n', { maxRows: 1 });
    expect(rows).toHaveLength(1);
  });
});
