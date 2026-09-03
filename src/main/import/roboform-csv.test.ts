// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto/errors.js';
import { loadFixture, withBom, withCrlf, withoutTrailingNewline } from './fixtures/load.js';
import { parseCsvTable } from './csv.js';
import { SPECIFIC_PARSERS } from './index.js';
import { roboformCsvParser } from './roboform-csv.js';

const fixture = loadFixture('roboform.csv');
const result = roboformCsvParser.parse(fixture);
const [mail, forum, wifi, bank] = result.records;

describe('roboform CSV', () => {
  it('maps the login columns, including the `Pwd` spelling nothing else uses', () => {
    expect(mail?.title).toBe('Example Mail');
    expect(mail?.username).toBe('ada@example.com');
    expect(mail?.password).toBe('hunter2');
    expect(mail?.urls).toEqual(['https://mail.example.com/login']);
    expect(mail?.notes).toBe('Renew the domain before 30 June, ask Bob');
  });

  it('reads a `/`-rooted folder as a path, not as a folder with a nameless parent', () => {
    // Injection: `folder: 'folder'` changed to `folder: 'custom'`, the mapping slip that turns
    // a folder tree into a per-record text field. Caught here — every `folderId` comes back
    // null and the import lands flat.
    expect(mail?.folderId).toBe('import-folder:Personal');
    expect(forum?.folderId).toBe('import-folder:Personal/Communities');
    expect(result.folders).toEqual(['Home', 'Personal', 'Personal/Communities']);
  });

  it('leaves a record with no folder unfiled rather than inventing one', () => {
    expect(bank?.folderId).toBe(null);
  });

  it('keeps a MatchUrl that differs from the Url, as a field and not as a URL', () => {
    // The security-shaped assertion here. A RoboForm matching rule may be a wildcard pattern,
    // and putting `https://*.example.org/*` in the record's URL list would make it a target for
    // every future domain match and every "open this site" affordance — an address the user
    // never had. Injection: `matchurl` remapped to the `url` target. Caught by both halves.
    expect(forum?.urls).toEqual(['https://forum.example.org/']);
    expect(forum?.custom?.[0]).toMatchObject({
      label: 'Match URL',
      type: 'url',
      value: 'https://*.example.org/*',
    });
  });

  it('adds nothing when the MatchUrl is just the Url again', () => {
    // The common case by a wide margin. A "Match URL" field on every record would be noise, and
    // noise in the field list is how a real field goes unnoticed.
    //
    // Injection: `sameAddress` made to return `false` always. Caught here.
    expect(mail?.custom).toEqual([]);
    expect(bank?.custom).toEqual([]);
  });

  it('imports a note-shaped row with no login at all', () => {
    expect(wifi?.title).toBe('Wifi Codes');
    expect(wifi?.password).toBe('');
    expect(wifi?.urls).toEqual([]);
    expect(wifi?.notes).toBe('Guest network passphrase is taped to the router');
  });

  it('warns about nothing at all on a clean export', () => {
    expect(result.warnings).toEqual([]);
  });

  it('claims its own export and not another manager’s', () => {
    expect(roboformCsvParser.detect(fixture)).toBe(true);
    for (const name of ['chrome.csv', 'generic.csv', 'nordpass.csv', 'keeper.csv']) {
      expect(roboformCsvParser.detect(loadFixture(name)), name).toBe(false);
    }
  });

  it('is claimed by no other format in the registry', () => {
    // The other direction of the same property, and the one `index.test.ts` will assert once
    // this parser is registered — it can only check parsers already in the array, so until then
    // the check lives here. An ambiguous `detect` does not fail loudly: it reads a RoboForm
    // export through somebody else's parser and hands back plausible, wrong records.
    const claimants = SPECIFIC_PARSERS.filter(
      (parser) => parser.id !== roboformCsvParser.id && parser.detect(fixture)
    );
    expect(claimants.map((parser) => parser.id)).toEqual([]);
  });
});

describe('roboform CSV — refusing a shape it does not recognise', () => {
  it('throws rather than importing nothing from a file that is not RoboForm', () => {
    // The failure that matters. Run through the mapping table, a foreign CSV yields a pile of
    // custom fields or zero records and a warning nobody reads, and the user concludes their
    // data moved. Injection: the header check deleted. Caught here.
    const chromium = loadFixture('chrome.csv');
    expect(() => roboformCsvParser.parse(chromium)).toThrow(VaultError);
    expect(() => roboformCsvParser.parse(chromium)).toThrow(/not a RoboForm CSV export/);
  });

  it('names the missing column and the format that would have worked', () => {
    expect(() => roboformCsvParser.parse(loadFixture('chrome.csv'))).toThrow(/"pwd"/);
    expect(() => roboformCsvParser.parse(loadFixture('chrome.csv'))).toThrow(/Any CSV file/);
  });

  it('still reads a build that dropped the MatchUrl column', () => {
    // Detection is a suggestion and may be shy; `parse` runs because the user chose this
    // format, and refusing it over one absent column would be the app overruling somebody who
    // knows what their own export is.
    const trimmed = 'Url,Name,Login,Pwd,Note,Folder\nhttps://x.example.com,Example,ada,hunter2,,\n';
    expect(roboformCsvParser.parse(trimmed).records[0]?.password).toBe('hunter2');
  });
});

/**
 * The properties `parser-contract.test.ts` will assert automatically once this parser is in the
 * registry. Until then they are asserted here, because a parser nobody has registered yet is
 * exactly the one that ships with a hole in it.
 */
describe('roboform CSV — the parser contract', () => {
  it('survives a BOM, CRLF line endings and a missing trailing newline together', () => {
    const mangled = withBom(withCrlf(withoutTrailingNewline(fixture)));
    expect(roboformCsvParser.parse(mangled).records).toEqual(result.records);
  });

  it('refuses an empty file with a VaultError rather than reporting a successful import', () => {
    expect(() => roboformCsvParser.parse('')).toThrow(VaultError);
  });

  it('reads a header with no rows without throwing', () => {
    const headerOnly = `${fixture.split('\n')[0] ?? ''}\n`;
    expect(roboformCsvParser.parse(headerOnly)).toMatchObject({ records: [], folders: [] });
  });

  it('turns a malformed row into a warning rather than an exception', () => {
    const parsed = roboformCsvParser.parse(`${fixture}one,two,three\n`);
    expect(parsed.records.length).toBeGreaterThan(0);
    expect(parsed.warnings.some((warning) => warning.kind === 'ragged-row')).toBe(true);
  });

  it('never puts a field value in a warning message', () => {
    // A property over every value in the fixture, not a list of known passwords: a list can only
    // catch the leaks somebody already thought of. Same reasoning as in
    // `parser-contract.test.ts`.
    //
    // Injection: the hook made to warn `Match URL "<value>" was kept as a field.` Caught here,
    // naming the leaked value.
    const values = valuesOf(fixture);
    expect(values.length).toBeGreaterThan(3);
    for (const source of [fixture, `${fixture}one,two,three\n`]) {
      for (const warning of roboformCsvParser.parse(source).warnings) {
        for (const value of values) {
          expect(warning.message, `leaked "${value}"`).not.toContain(value);
        }
      }
    }
  });

  it('gives every record a non-empty title and lists every folder they point at', () => {
    for (const record of result.records) {
      expect(record.title.trim()).not.toBe('');
      if (typeof record.folderId !== 'string') continue;
      expect(result.folders).toContain(record.folderId.replace('import-folder:', ''));
    }
  });

  it('does not throw from detect, whatever it is handed', () => {
    for (const junk of ['', '\0\0\0', '{', 'not,a,real\nfile', '"unclosed']) {
      expect(() => roboformCsvParser.detect(junk)).not.toThrow();
    }
  });
});

/** Every cell value long enough to be recognisable, excluding anything used as a header. */
function valuesOf(source: string): string[] {
  const { table } = parseCsvTable(source);
  const headers = new Set(table.columns.map((column) => column.toLowerCase()));
  return [...new Set(table.rows.flatMap((row) => [...row.cells]))].filter(
    (value) => value.trim().length >= 8 && !headers.has(value.trim().toLowerCase())
  );
}
