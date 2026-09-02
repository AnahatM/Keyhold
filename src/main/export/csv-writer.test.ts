// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseCsvTable } from '../import/csv.js';
import {
  BOM,
  escapeCell,
  FORMULA_TRIGGERS,
  isFormula,
  neutraliseFormula,
  writeCsv,
} from './csv-writer.js';

/**
 * The CSV writer's tests.
 *
 * **A bug here is a bug in both CSV exports at once**, and one of the two possible bugs is a
 * remote-code-execution vector rather than a formatting nuisance. So the formula-injection
 * block below carries the real payload — the one that has actually been used against
 * spreadsheet exports — rather than a polite `=1+1`.
 *
 * The other half of the file is the boring half, and it is boring on purpose: an export that
 * mangles a note containing a comma is an export that has lost data, and the user will not
 * find out until they try to use the password it shifted into the wrong column.
 *
 * Fault injections performed against this file, all reverted:
 *
 *  1. `neutraliseFormula` made a no-op. 7 failed, four here and three in `csv.test.ts`.
 *  2. Neutralisation moved to *after* escaping. 1 failed — and only one, which is why the
 *     "guards inside the quotes" case exists: every other injection-related assertion still
 *     passed, because the guard was still there, just in the wrong place.
 *  3. `escapeCell` stopped doubling embedded quotes. 3 failed.
 *  4. The BOM dropped from the default. 1 failed.
 *  5. The row loop bounded by the row rather than the header, leaving short rows unpadded.
 *     1 failed.
 */

describe('formula injection', () => {
  /**
   * The payload. `=cmd|'/c calc'!A0` is a DDE formula: Excel offers to run `cmd` when the
   * sheet is opened. Anything that reaches a credential store can reach an export, so this
   * is not a hypothetical shape — it is a shared entry or a phished import away.
   */
  const PAYLOAD = "=cmd|'/c calc'!A0";

  it('neutralises the real payload rather than writing it as a formula', () => {
    const { text } = writeCsv(['password'], [[PAYLOAD]], { bom: false });
    const { table } = parseCsvTable(text);

    const cell = table.rows[0]?.values.get('password');
    expect(cell).toBe(`'${PAYLOAD}`);
    expect(cell?.startsWith('=')).toBe(false);
  });

  it('neutralises every trigger character', () => {
    for (const trigger of FORMULA_TRIGGERS) {
      expect(isFormula(`${trigger}danger`)).toBe(true);
      expect(neutraliseFormula(`${trigger}danger`)).toBe(`'${trigger}danger`);
    }
  });

  it('leaves an ordinary value untouched', () => {
    expect(neutraliseFormula('hunter2')).toBe('hunter2');
    expect(neutraliseFormula('')).toBe('');
    // The trigger only matters in first position — a formula character mid-value is data.
    expect(neutraliseFormula('a=b')).toBe('a=b');
  });

  it('guards inside the quotes, not outside them', () => {
    // Order matters and is invisible in the output unless the cell also needs quoting. A
    // guard added after escaping produces `'"=a,b"`, which every reader disagrees about.
    const { text } = writeCsv(['notes'], [['=a,b']], { bom: false });
    expect(text).toContain(`"'=a,b"`);
    expect(text).not.toContain(`'"=a`);

    const { table } = parseCsvTable(text);
    expect(table.rows[0]?.values.get('notes')).toBe(`'=a,b`);
  });

  it('reports which columns were neutralised and how many, in header order', () => {
    const { neutralised } = writeCsv(
      ['title', 'password'],
      [
        ['=one', '=two'],
        ['safe', '+three'],
      ],
      { bom: false }
    );

    expect(neutralised).toEqual([
      { column: 'title', cells: 1 },
      { column: 'password', cells: 2 },
    ]);
  });

  it('can be turned off, because someone feeding a script is not opening a spreadsheet', () => {
    const { text, neutralised } = writeCsv(['password'], [[PAYLOAD]], {
      bom: false,
      formulaGuard: false,
    });
    expect(text).toContain(PAYLOAD);
    expect(text).not.toContain(`'${PAYLOAD}`);
    expect(neutralised).toEqual([]);
  });
});

describe('escaping', () => {
  it('quotes a cell containing the delimiter', () => {
    expect(escapeCell('one, two', ',')).toBe('"one, two"');
  });

  it('doubles an embedded quote', () => {
    expect(escapeCell('3" pipe', ',')).toBe('"3"" pipe"');
  });

  it('quotes a cell containing a newline', () => {
    expect(escapeCell('line one\nline two', ',')).toBe('"line one\nline two"');
    expect(escapeCell('line one\r\nline two', ',')).toBe('"line one\r\nline two"');
  });

  it('leaves an ordinary cell unquoted', () => {
    expect(escapeCell('hunter2', ',')).toBe('hunter2');
  });

  it('survives a round trip through the reader with every awkward character at once', () => {
    const nasty = 'a "quoted" value, with a comma\nand a newline';
    const { text } = writeCsv(['notes', 'password'], [[nasty, 'p,ss"word']], { bom: false });
    const { table } = parseCsvTable(text);

    expect(table.rows).toHaveLength(1);
    // The reader normalises CRLF inside a quoted field to a plain newline, which is what the
    // vault should hold — so the comparison is against the newline form, not the CRLF one.
    expect(table.rows[0]?.values.get('notes')).toBe(nasty);
    expect(table.rows[0]?.values.get('password')).toBe('p,ss"word');
  });
});

describe('the BOM', () => {
  it('is emitted by default, so Excel does not open UTF-8 as the ANSI code page', () => {
    const { text } = writeCsv(['title'], [['café']]);
    expect(text.startsWith(BOM)).toBe(true);
  });

  it('can be suppressed for a consumer that does not want one', () => {
    const { text } = writeCsv(['title'], [['café']], { bom: false });
    expect(text.startsWith(BOM)).toBe(false);
    expect(text.startsWith('title')).toBe(true);
  });

  it('does not corrupt the first column name for our own reader', () => {
    // This is the failure a BOM actually causes: not mangled values, a mangled first *header*,
    // so every lookup of `title` misses and every title imports blank with no error anywhere.
    const { text } = writeCsv(['title', 'password'], [['Example', 'hunter2']]);
    const { table } = parseCsvTable(text);
    expect(table.keys).toEqual(['title', 'password']);
    expect(table.rows[0]?.values.get('title')).toBe('Example');
  });
});

describe('rows', () => {
  it('pads a short row rather than shifting the remaining values left', () => {
    // The failure mode this prevents is a password landing in the notes column, which is a
    // data-loss bug that looks like a formatting one.
    const { text } = writeCsv(['a', 'b', 'c'], [['1']], { bom: false });
    const { table } = parseCsvTable(text);
    expect(table.rows[0]?.cells).toEqual(['1', '', '']);
  });

  it('ends the file with a line ending, so two exports can be concatenated', () => {
    const { text } = writeCsv(['a'], [['1']], { bom: false });
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('writes a header-only file when there are no rows', () => {
    const { text } = writeCsv(['a', 'b'], [], { bom: false });
    expect(text).toBe('a,b\r\n');
  });
});

describe('determinism', () => {
  it('produces identical text for identical input', () => {
    const header = ['title', 'password', 'notes'];
    const rows = [
      ['Example', '=formula', 'a,b'],
      ['Other', 'hunter2', 'plain'],
    ];
    expect(writeCsv(header, rows).text).toBe(writeCsv(header, rows).text);
  });
});
