// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto/errors.js';
import {
  FIXTURE_FOR_PARSER,
  headerOnly,
  loadBinaryFixture,
  loadFixture,
  withBom,
  withCrlf,
  withoutTrailingNewline,
} from './fixtures/load.js';
import { parseCsvTable } from './csv.js';
import { buildZip } from './fixtures/zip-writer.js';
import { ZIP_METHOD_STORED, ZipArchive } from './zip-reader.js';
import { parseXml, type XmlElement } from './xml-reader.js';
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
  'keyhold-json': 'Recovery kit is in the safe, not the drawer',
  'proton-pass-json': 'Backup phrase is in the safe, not the drawer',
  'enpass-json': 'Recovery kit is in the loft, not the cupboard',
  'dashlane-json': 'Renewal is in March, not January',
  'keeper-csv': 'Recovery codes are in the safe, not the drawer',
  'roboform-csv': 'Renew the domain before 30 June, ask Bob',
  'onepassword-1pux': 'The recovery kit is in the safe, not the drawer',
  'keepass-xml': 'Recovery kit is in the safe, not the drawer',
};

/**
 * Formats whose file is not text.
 *
 * `.1pux` is a ZIP archive, and four of the cases below exist to mangle text: adding a BOM,
 * rewriting line endings, appending a ragged row, and reading the fixture's own cells. Every
 * one of them corrupts an archive rather than exercising a parser, so those cases take an
 * archive-shaped route or are skipped with the reason said out loud.
 *
 * This is a seam, not a workaround, and the seam is in the wrong place: `ImportParser.parse`
 * takes a `string`, which is right for the eleven text formats and structurally wrong for
 * this one. The durable fix is an optional `parseBytes` on the parser interface with the
 * string form as an adapter — and the same wall is waiting for KDBX, so it will have to be
 * built. Until then a `.1pux` reaches the parser through a `latin1` round-trip, which is the
 * one encoding that maps all 256 byte values to distinct code points and so survives the
 * string contract byte for byte.
 */
const BINARY_PARSERS: ReadonlySet<string> = new Set(['onepassword-1pux']);

function shapeOf(parserId: string): FixtureShape {
  if (JSON_FIXTURES.has(parserId)) return 'json';
  if (XML_FIXTURES.has(parserId)) return 'xml';
  return 'csv';
}

/**
 * Fixtures that are JSON, whose leak guard walks string leaves rather than CSV cells.
 *
 * A set rather than `id === 'bitwarden-json'`, which is what it was: the moment a second JSON
 * parser was registered, the check ran its fixture through `parseCsvTable` and produced a
 * meaningless cell list, so the leak property held against nothing at all.
 */
const JSON_FIXTURES: ReadonlySet<string> = new Set([
  'bitwarden-json',
  'keyhold-json',
  'proton-pass-json',
  'enpass-json',
  'dashlane-json',
]);

/**
 * Fixtures that are XML, whose values are element text and attributes rather than cells.
 *
 * Same reasoning as `JSON_FIXTURES` and the same trap: without a branch here the leak guard
 * would run an XML document through `parseCsvTable`, get a nonsense cell list, and hold
 * against nothing.
 */
const XML_FIXTURES: ReadonlySet<string> = new Set(['keepass-xml']);

/** Converts a `latin1`-carried archive back to bytes. The exact inverse of `loadBinaryFixture`. */
function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

/** The `export.data` JSON inside a `.1pux` carried as a `latin1` string. */
function readOnePasswordExportData(fixture: string): string {
  return ZipArchive.open(new Uint8Array(Buffer.from(fixture, 'latin1'))).readText('export.data');
}

/**
 * Formats this app wrote itself, which are read all-or-nothing.
 *
 * Every other parser is deliberately lenient: refusing a 3,000-row export over one bad line
 * is how a user ends up retyping their vault by hand, so a malformed row becomes a warning.
 *
 * Keyhold's own format is the opposite case, and for a reason worth stating. A malformed
 * record in a file *we* wrote does not mean one odd row — it means the file is damaged or
 * was edited by hand, and importing the rest of it produces a silently incomplete vault
 * that looks complete. The same reader also opens the encrypted `.keepx` parcel, where
 * partial acceptance would be plainly wrong.
 *
 * So these parsers are permitted to throw a `VaultError` where the lenient ones must warn.
 */
const STRICT_PARSERS: ReadonlySet<string> = new Set(['keyhold-json']);

/** The structurally-empty form of each format: a header with no rows, or an empty item list. */
function emptyOf(parserId: string, fixture: string): string {
  if (parserId === 'bitwarden-json') {
    // `folderId` is what the narrowed `detect` keys off, and an empty export still has to be
    // recognised as Bitwarden's — otherwise this case would be testing that a file nobody
    // claims produces no records, which is true of any file.
    return '{"encrypted":false,"folders":[],"items":[],"folderId":null}';
  }
  if (parserId === 'proton-pass-json') {
    return '{"encrypted":false,"vaults":{"share-1":{"name":"Personal","items":[]}}}';
  }
  if (parserId === 'enpass-json') return '{"folders":[],"items":[]}';
  if (parserId === 'dashlane-json') return '{"AUTHENTIFIANT":[],"SECURENOTE":[]}';
  if (parserId === 'onepassword-1pux') {
    return latin1(
      buildZip([
        {
          name: 'export.data',
          data: JSON.stringify({
            accounts: [{ vaults: [{ attrs: { name: 'Personal' }, items: [] }] }],
          }),
          method: ZIP_METHOD_STORED,
        },
      ])
    );
  }
  if (parserId === 'keepass-xml') {
    // A database with its group tree and no entries in it — what KeePass exports from a file
    // somebody has only just created.
    return '<?xml version="1.0"?><KeePassFile><Meta><DatabaseName>Empty</DatabaseName></Meta><Root><Group><Name>Empty</Name></Group></Root></KeePassFile>';
  }
  if (parserId === 'keyhold-json') {
    // Built from the fixture rather than hand-written, so the envelope this asserts against
    // stays the envelope the exporter actually produces.
    const envelope = JSON.parse(fixture) as Record<string, unknown>;
    return JSON.stringify({ ...envelope, records: [], folders: [], tags: [] });
  }
  return headerOnly(fixture);
}

/** A row with the wrong number of cells, appended to the fixture. */
function withMalformedRow(parserId: string, fixture: string): string {
  if (parserId === 'bitwarden-json') {
    // The JSON analogue of a ragged row: an item that is not an object at all.
    return fixture.replace('"items": [', '"items": [\n    "not an item",');
  }
  if (parserId === 'keyhold-json') {
    return fixture.replace('"records": [', '"records": [\n    "not a record",');
  }
  if (parserId === 'proton-pass-json') {
    return fixture.replace('"items": [', '"items": [\n        "not an item",');
  }
  if (parserId === 'enpass-json') {
    return fixture.replace('"items": [', '"items": [\n    "not an item",');
  }
  if (parserId === 'dashlane-json') {
    return fixture.replace('"AUTHENTIFIANT": [', '"AUTHENTIFIANT": [\n    "not an item",');
  }
  if (parserId === 'keepass-xml') {
    // The XML analogue of a ragged row: a well-formed entry carrying a value the exporter
    // withheld. There is no such thing as a "wrong number of cells" in a document whose
    // structure is named rather than positional, so the case this stands in for is the one
    // that actually happens — a field arrives that cannot be read, and the other entries must
    // still come across.
    return fixture.replace(
      '</Root>',
      '<Entry><String><Key>Title</Key><Value>Withheld</Value></String>' +
        '<String><Key>Password</Key><Value Protected="True"/></String></Entry></Root>'
    );
  }
  if (parserId === 'onepassword-1pux') {
    // The archive analogue of a ragged row: a well-formed ZIP whose `export.data` holds an
    // item that is not an object. Appending bytes to the archive itself would test the ZIP
    // reader's bounds checking, which `zip-reader.test.ts` already does thoroughly.
    const data = JSON.parse(readOnePasswordExportData(fixture)) as Record<string, unknown>;
    const accounts = data.accounts as { vaults: { items: unknown[] }[] }[];
    accounts[0]?.vaults[0]?.items.push('not an item');
    return latin1(
      buildZip([{ name: 'export.data', data: JSON.stringify(data), method: ZIP_METHOD_STORED }])
    );
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
type FixtureShape = 'csv' | 'json' | 'xml';

function fixtureValues(fixture: string, shape: FixtureShape): string[] {
  const values =
    shape === 'json'
      ? jsonStringLeaves(fixture)
      : shape === 'xml'
        ? xmlTextValues(fixture)
        : csvCellValues(fixture);
  const headers = new Set(
    shape === 'csv' ? parseCsvTable(fixture).table.columns.map((column) => column.toLowerCase()) : []
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

/**
 * Every element's text and every attribute value in an XML fixture.
 *
 * Attributes included deliberately: `Protected="True"` is an attribute, and a future warning
 * that echoed one back would be leaking from the same file as any other value.
 */
function xmlTextValues(fixture: string): string[] {
  const values: string[] = [];
  const walk = (node: XmlElement): void => {
    values.push(node.text, ...Object.values(node.attributes));
    node.children.forEach(walk);
  };
  walk(parseXml(fixture));
  return values;
}

describe.each(PARSERS.map((parser) => [parser.id, parser] as const))(
  'the parser contract: %s',
  (id, parser) => {
    const fixtureName = FIXTURE_FOR_PARSER[id];
    if (fixtureName === undefined) throw new Error(`no fixture registered for parser "${id}"`);
    const binary = BINARY_PARSERS.has(id);
    const fixture = binary ? loadBinaryFixture(fixtureName) : loadFixture(fixtureName);

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

    // Skipped for a binary format, and said out loud rather than quietly excluded. Every one
    // of these three transformations *destroys* an archive rather than testing a parser
    // against it: a BOM shifts every offset in the file, and CRLF rewriting corrupts the
    // compressed stream. The thing this case protects — a file surviving Windows — is covered
    // for `.1pux` by the ZIP reader's own bounds and checksum tests, which is where a
    // byte-level corruption of an archive belongs.
    it.skipIf(binary)(
      'survives a BOM, CRLF line endings and a missing trailing newline together',
      () => {
        // Not asserted through a fixture on disk: `.gitattributes` normalises line endings, so a
        // CRLF fixture would silently become LF and the guard would stop guarding.
        const mangled = withBom(withCrlf(withoutTrailingNewline(fixture)));
        expect(parser.parse(mangled).records).toEqual(parser.parse(fixture).records);
      }
    );

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

      if (STRICT_PARSERS.has(id)) {
        // Permitted to refuse the file outright — see `STRICT_PARSERS`. What is *not*
        // permitted is throwing something the IPC layer would scrub into "something went
        // wrong": a `VaultError` carries a message written for a user.
        expect(() => parser.parse(damaged)).toThrow(VaultError);
        return;
      }

      const result = parser.parse(damaged);
      // The good rows still arrive. Refusing a 3,000-row export over one bad line is the
      // outcome this whole engine exists to avoid.
      expect(result.records.length).toBeGreaterThan(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('never puts a field value in a warning message', () => {
      // JSON fixtures have their string leaves walked; CSV fixtures have their cells read.
      // A `.1pux` is neither — its values live inside a compressed entry — so the archive is
      // opened and the export's own JSON is what gets walked.
      // Through `fixtureValues` in every case, including the archive. Calling
      // `jsonStringLeaves` directly skipped its filtering, and the filtering is load-bearing:
      // without it the empty strings in any fixture become needles, and `''` is contained in
      // every warning ever written.
      const values = binary
        ? fixtureValues(readOnePasswordExportData(fixture), 'json')
        : fixtureValues(fixture, shapeOf(id));
      expect(values.length, 'the fixture has no values worth checking').toBeGreaterThan(3);

      for (const source of [fixture, withMalformedRow(id, fixture), emptyOf(id, fixture)]) {
        // A strict parser refuses the damaged form; its refusal message is checked for the
        // same leak below, because an error is read in exactly the places a warning is.
        let warnings;
        try {
          warnings = parser.parse(source).warnings;
        } catch (error) {
          expect(STRICT_PARSERS.has(id), `${id} threw on a source it should have warned on`).toBe(
            true
          );
          const message = error instanceof Error ? error.message : String(error);
          for (const value of values) {
            expect(message, `an error leaked the value "${value}"`).not.toContain(value);
          }
          continue;
        }

        for (const warning of warnings) {
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
