// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto/errors.js';
import {
  FIXTURE_FOR_PARSER,
  headerOnly,
  loadFixture,
  withBom,
  withCrlf,
  withoutTrailingNewline,
} from './fixtures/load.js';
import { parseCsvTable } from './csv.js';
import { PARSERS } from './index.js';

/**
 * The contract every parser must satisfy, applied to every parser in the registry.
 *
 * Written table-driven rather than copied into eleven files for one reason: **adding a parser
 * must automatically extend this suite**. A per-format copy of these cases is a set of rules
 * the twelfth parser can quietly skip, and the twelfth parser is the one written in a hurry.
 *
 * Fault injections performed:
 *
 *  1. The `ragged-row` warning deleted from `parseCsvTable`. Caught: "turns a malformed row
 *     into a warning rather than an exception" failed for three formats at once — exactly the
 *     fan-out this file exists to cover.
 *  2. The unmapped-column warning changed to quote an example cell value, which is a very
 *     plausible "help the user find it" mistake. **This exposed a real weakness in the test.**
 *     The leak guard was originally a list of five known passwords, and the injected leak was
 *     an account number and a URL, so it passed. The guard is now a property over *every*
 *     value in the fixture; re-injected, it fails on two formats as it should.
 *
 * Both were restored, and all 121 cases pass again.
 *
 * Format-specific field mapping is asserted in each parser's own `*.test.ts`; this file only
 * asserts the properties that must hold for all of them.
 */

/** A value in each fixture that contains a comma inside a quoted field. */
const COMMA_VALUE: Readonly<Record<string, string>> = {
  'bitwarden-json': 'Recovery kit is in the safe, not the drawer',
  'bitwarden-csv': 'Recovery kit is in the safe, not the drawer',
  'lastpass-csv': 'Delivery address: 12 High Street, Springfield',
  'firefox-csv': 'Example Router, admin realm',
  'dashlane-csv': 'Shared with the team, rotate quarterly',
  'nordpass-csv': 'Recovery address is bob@example.com, not mine',
  'keepass-csv': 'Recovery kit, kept offline',
  'onepassword-csv': 'Security question: first pet, answered in the safe',
  'safari-csv': 'Backup codes: 1111, 2222, 3333',
  'chrome-csv': 'Shared with Bob, expires in June',
  'generic-csv': 'Billed annually, purchase order required',
};

/** The structurally-empty form of each format: a header with no rows, or an empty item list. */
function emptyOf(parserId: string, fixture: string): string {
  return parserId === 'bitwarden-json' ? '{"encrypted":false,"items":[]}' : headerOnly(fixture);
}

/** A row with the wrong number of cells, appended to the fixture. */
function withMalformedRow(parserId: string, fixture: string): string {
  if (parserId === 'bitwarden-json') {
    // The JSON analogue of a ragged row: an item that is not an object at all.
    return fixture.replace('"items": [', '"items": [\n    "not an item",');
  }
  return `${fixture}one,two,three\n`;
}

/**
 * **Every value in the fixture** must be absent from every warning message.
 *
 * Warnings are rendered on screen, written into the import report and pasted into bug
 * reports. A message that quoted the cell it could not map would put a password in all three,
 * which is hard rule 1. Messages name columns and line numbers, never content.
 *
 * Formulated as a property over the whole fixture rather than a list of known passwords, and
 * that is the point — the first version *was* a list of five markers, and a fault injection
 * that echoed a cell into a warning sailed straight past it, because the leaked cell happened
 * not to be on the list. A hand-written list of secrets can only catch the leaks someone
 * already thought of.
 *
 * Column *headers* are excluded, because naming the column is the whole job of a warning.
 * Short values are excluded because "0", "true" and "Work" appear in ordinary English.
 */
function fixtureValues(fixture: string, isJson: boolean): string[] {
  const values = isJson ? jsonStringLeaves(fixture) : csvCellValues(fixture);
  const headers = new Set(
    isJson ? [] : parseCsvTable(fixture).table.columns.map((column) => column.toLowerCase())
  );
  return [...new Set(values)].filter(
    (value) => value.trim().length >= 8 && !headers.has(value.trim().toLowerCase())
  );
}

function csvCellValues(fixture: string): string[] {
  return parseCsvTable(fixture).table.rows.flatMap((row) => [...row.cells]);
}

function jsonStringLeaves(fixture: string): string[] {
  const leaves: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') leaves.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (typeof node === 'object' && node !== null) Object.values(node).forEach(walk);
  };
  walk(JSON.parse(fixture));
  return leaves;
}

describe.each(PARSERS.map((parser) => [parser.id, parser] as const))(
  'the parser contract: %s',
  (id, parser) => {
    const fixtureName = FIXTURE_FOR_PARSER[id];
    if (fixtureName === undefined) throw new Error(`no fixture registered for parser "${id}"`);
    const fixture = loadFixture(fixtureName);

    it('parses its own fixture into at least one record', () => {
      expect(parser.parse(fixture).records.length).toBeGreaterThan(0);
    });

    it('gives every record a non-empty title', () => {
      // An untitled record is unusable in a list, and Firefox's export has no title column at
      // all — so this is a real case, not a defensive one.
      for (const record of parser.parse(fixture).records) {
        expect(record.title.trim()).not.toBe('');
      }
    });

    it('keeps a quoted field containing a comma intact', () => {
      const expected = COMMA_VALUE[id];
      expect(expected, `no comma-bearing value registered for "${id}"`).toBeDefined();
      const serialised = JSON.stringify(parser.parse(fixture).records);
      expect(serialised).toContain(expected ?? '');
    });

    it('survives a BOM, CRLF line endings and a missing trailing newline together', () => {
      // Not asserted through a fixture on disk: `.gitattributes` normalises line endings, so a
      // CRLF fixture would silently become LF and the guard would stop guarding.
      const mangled = withBom(withCrlf(withoutTrailingNewline(fixture)));
      expect(parser.parse(mangled).records).toEqual(parser.parse(fixture).records);
    });

    it('reads an empty file without throwing anything but a VaultError', () => {
      try {
        expect(parser.parse('').records).toEqual([]);
      } catch (error) {
        expect(error).toBeInstanceOf(VaultError);
      }
    });

    it('reads a file with no records without throwing', () => {
      const result = parser.parse(emptyOf(id, fixture));
      expect(result.records).toEqual([]);
      expect(result.folders).toEqual([]);
    });

    it('turns a malformed row into a warning rather than an exception', () => {
      const damaged = withMalformedRow(id, fixture);
      const result = parser.parse(damaged);
      // The good rows still arrive. Refusing a 3,000-row export over one bad line is the
      // outcome this whole engine exists to avoid.
      expect(result.records.length).toBeGreaterThan(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('never puts a field value in a warning message', () => {
      const values = fixtureValues(fixture, id === 'bitwarden-json');
      expect(values.length, 'the fixture has no values worth checking').toBeGreaterThan(3);

      for (const source of [fixture, withMalformedRow(id, fixture), emptyOf(id, fixture)]) {
        for (const warning of parser.parse(source).warnings) {
          for (const value of values) {
            expect(warning.message, `a warning leaked the value "${value}"`).not.toContain(value);
          }
        }
      }
    });

    it('lists every folder its records point at', () => {
      const result = parser.parse(fixture);
      const referenced = new Set(
        result.records
          .map((record) => record.folderId)
          .filter((folderId): folderId is string => typeof folderId === 'string')
      );
      for (const folderId of referenced) {
        const path = folderId.replace('import-folder:', '');
        expect(result.folders, `folder "${path}" is referenced but not listed`).toContain(path);
      }
    });

    it('detects its own fixture, unless it is the mapping-driven catch-all', () => {
      // The generic parser's registry entry claims any delimited file by design, so "detects
      // its own fixture" says nothing about it either way — but it must still say yes.
      expect(parser.detect(fixture)).toBe(true);
    });

    it('does not throw from detect, whatever it is handed', () => {
      for (const junk of ['', '\0\0\0', '{', 'not,a,real\nfile', '"unclosed']) {
        expect(() => parser.detect(junk)).not.toThrow();
      }
    });
  }
);
