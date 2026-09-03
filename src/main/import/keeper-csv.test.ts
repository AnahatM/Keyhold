// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { isCustomFieldValueSecret } from '@shared/model/credential.js';
import { VaultError } from '../crypto/errors.js';
import { loadFixture, withBom, withCrlf, withoutTrailingNewline } from './fixtures/load.js';
import { parseCsvRows } from './csv.js';
import { SPECIFIC_PARSERS } from './index.js';
import { keeperCsvParser } from './keeper-csv.js';

/**
 * Keeper's two shapes, and the positional custom-field pairs that make it unlike every other
 * CSV in the registry.
 *
 * Fault injections performed are recorded against the assertion that caught each one, in the
 * test's own comment, so a future reader can tell which lines are load-bearing.
 */

const headed = loadFixture('keeper.csv');
const headerless = loadFixture('keeper-headerless.csv');

const result = keeperCsvParser.parse(headed);
const [mail, build, bank, insurance] = result.records;

describe('keeper CSV — the headed export', () => {
  it('maps the seven fixed columns', () => {
    expect(mail?.title).toBe('Example Mail');
    expect(mail?.username).toBe('ada@example.com');
    expect(mail?.password).toBe('hunter2');
    expect(mail?.urls).toEqual(['https://mail.example.com']);
    expect(mail?.notes).toBe('Recovery codes are in the safe, not the drawer');
    expect(mail?.folderId).toBe('import-folder:Personal');
  });

  it('reads the trailing cells as custom-field name/value pairs', () => {
    // Injection: `cells.slice(fixedCount)` changed to `cells.slice(fixedCount + 1)`, the
    // off-by-one a positional reader invites. Caught here and by eight other assertions — the
    // pairs shift by one, so the label becomes the previous field's value and the otpauth seed
    // ends up in a field named after somebody's account number.
    expect(mail?.custom?.map((field) => [field.label, field.value])).toEqual([
      ['Account number', '4471-9902'],
      ['TFC:Keeper', 'otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP&issuer=Example'],
    ]);
  });

  it('does not let a pair *header* become a field whose value is a field name', () => {
    // The whole reason this parser builds its own table. If `Custom Field 1 Name` were treated
    // as an ordinary column, every record would gain a field literally called
    // "Custom Field 1 Name" holding the *name* of the real field.
    //
    // Injection: the `.slice(0, KEEPER_COLUMNS.length)` that truncates the header removed.
    // Caught here, and the otpauth seed's type collapses from `otp-secret` to `text` at the
    // same time — which is the leak that failure actually costs.
    const labels = result.records.flatMap((record) =>
      (record.custom ?? []).map((field) => field.label)
    );
    expect(labels.some((label) => /^custom field/i.test(label))).toBe(false);
  });

  it('gives an otpauth pair a secret type from its value, not from its name', () => {
    // `TFC:Keeper` means nothing to the label patterns. The value does, and that is the point:
    // the seed reaches an `otp-secret` field — and so never reaches the renderer — without this
    // parser having to know what Keeper calls the column.
    const otp = mail?.custom?.[1];
    expect(otp?.type).toBe('otp-secret');
    expect(isCustomFieldValueSecret(otp!)).toBe(true);
  });

  it('keeps a shared folder’s name when a personal folder already won the record', () => {
    // Injection: `carrySharedFolder` deleted. Caught here — "Ops Team" vanishes with no
    // warning, which is the silent loss the engine exists to prevent.
    expect(build?.folderId).toBe('import-folder:Work/Infrastructure');
    expect(build?.custom?.[0]).toMatchObject({ label: 'Keeper shared folder', value: 'Ops Team' });
  });

  it('falls back to the shared folder when the record has no personal one', () => {
    expect(insurance?.folderId).toBe('import-folder:Household');
    expect(insurance?.custom).toEqual([]);
  });

  it('nests a folder on its backslash and lists every ancestor', () => {
    expect(result.folders).toEqual([
      'Finance',
      'Household',
      'Personal',
      'Work',
      'Work/Infrastructure',
    ]);
  });

  it('types a PIN pair from its label rather than as a plain number', () => {
    const pin = bank?.custom?.[0];
    expect(pin).toMatchObject({ label: 'Security PIN', type: 'pin' });
    expect(isCustomFieldValueSecret(pin!)).toBe(true);
  });

  it('warns about nothing at all on a clean export', () => {
    // A parser that warns on every good file trains the user to ignore the warning list, which
    // is where the real losses are reported.
    expect(result.warnings).toEqual([]);
  });
});

describe('keeper CSV — the headerless export', () => {
  const bare = keeperCsvParser.parse(headerless);

  it('reads the first line as a record rather than eating it as a header', () => {
    // Injection: `headed` forced to `true`. Caught here — the record count drops to two and
    // "Example Mail" disappears entirely, which is the exact failure a synthesised header row
    // would have hidden.
    expect(bare.records.map((record) => record.title)).toEqual([
      'Example Mail',
      'Build Server',
      'Example Bank',
    ]);
  });

  it('reports a problem against the real line number, not one shifted by a header', () => {
    // Injection: `line: raw.line + 1` in `buildKeeperTable`, which is exactly the off-by-one
    // the rejected fix-up — splice a synthetic header onto the front, hand it to
    // `parseCsvTable` — would have introduced. Caught here: the warning comes back pointing at
    // line 5, and a warning that points at the wrong line sends the user looking in the wrong
    // place in a file they are already anxious about.
    const damaged = `${headerless}Personal,Truncated,ada,hunter2,https://x.example.com,,,orphan\n`;
    expect(keeperCsvParser.parse(damaged).warnings.map((warning) => warning.line)).toEqual([4]);
  });

  it('carries the same fields the headed export does', () => {
    const [mailRow] = bare.records;
    expect(mailRow?.password).toBe('hunter2');
    expect(mailRow?.custom?.[0]).toMatchObject({ label: 'Account number', value: '4471-9902' });
  });

  it('is detected on its own, without a header to go on', () => {
    expect(keeperCsvParser.detect(headerless)).toBe(true);
  });

  it('is not claimed on the strength of a header row belonging to something else', () => {
    // The heuristic's only real job. Every other export in the registry names at least one
    // recognisable column, and claiming one of those files would read its columns in Keeper's
    // order and produce plausible, wrong records with no error at all.
    for (const name of ['chrome.csv', 'generic.csv', 'firefox.csv', 'nordpass.csv']) {
      expect(keeperCsvParser.detect(loadFixture(name)), name).toBe(false);
    }
  });

  it('is claimed by no other format in the registry, in either shape', () => {
    // The other direction of the same property, and the one `index.test.ts` will assert once
    // this parser is registered — it can only check parsers that are already in the array, so
    // until then the check lives here. Getting it wrong does not produce an error: it produces
    // a Keeper export read through somebody else's parser, which drops nothing, reads the wrong
    // columns, and hands back plausible, wrong records.
    for (const fixture of [headed, headerless]) {
      const claimants = SPECIFIC_PARSERS.filter(
        (parser) => parser.id !== keeperCsvParser.id && parser.detect(fixture)
      );
      expect(claimants.map((parser) => parser.id)).toEqual([]);
    }
  });
});

describe('keeper CSV — a value it cannot name', () => {
  /** Two well-formed rows and one that ends mid-pair, so the majority rule still accepts it. */
  const orphaned = [
    'Personal,Example Mail,ada@example.com,hunter2,https://mail.example.com,,',
    'Personal,Example Forum,ada,tr0ub4dor,https://forum.example.org,,',
    'Personal,Example Bank,ada,s3cur3-p0licy,https://bank.example.org,,,recovery-kit-9902',
    '',
  ].join('\n');

  const result = keeperCsvParser.parse(orphaned);

  it('keeps an unpaired trailing cell rather than dropping it', () => {
    expect(result.records[2]?.custom?.[0]?.value).toBe('recovery-kit-9902');
  });

  it('gives a value it cannot name a secret type, so it stays out of the renderer', () => {
    // The security assertion in this file. With no label the type guesser falls back on the
    // value's shape and returns `text` for most secrets — which puts them in the safe
    // projection (decision D13). Injection: the forced `'password'` removed and the guesser
    // left to decide. Caught here — the type comes back `text`.
    const field = result.records[2]?.custom?.[0];
    expect(field?.label).toBe('Unnamed Keeper field 1');
    expect(isCustomFieldValueSecret(field!)).toBe(true);
  });

  it('says the row was unpaired without quoting what was in it', () => {
    const [warning] = result.warnings;
    expect(warning?.kind).toBe('ragged-row');
    expect(warning?.message).toContain('unpaired');
    expect(warning?.message).not.toContain('recovery-kit-9902');
  });

  it('gives an unnamed pair the same treatment as an orphan', () => {
    const blank = [
      'Personal,Example Mail,ada@example.com,hunter2,https://mail.example.com,,,,unlabelled-secret',
      'Personal,Example Forum,ada,tr0ub4dor,https://forum.example.org,,',
      '',
    ].join('\n');
    const field = keeperCsvParser.parse(blank).records[0]?.custom?.[0];
    expect(field).toMatchObject({ label: 'Unnamed Keeper field 1', value: 'unlabelled-secret' });
    expect(isCustomFieldValueSecret(field!)).toBe(true);
  });
});

describe('keeper CSV — refusing a shape it does not recognise', () => {
  it('throws on a file that is neither Keeper shape, rather than importing nothing', () => {
    // The failure that matters most. Silently returning zero records tells the user their data
    // moved, and they delete the source.
    const chromium = loadFixture('chrome.csv');
    expect(() => keeperCsvParser.parse(chromium)).toThrow(VaultError);
    expect(() => keeperCsvParser.parse(chromium)).toThrow(/not a Keeper CSV export/);
  });

  it('names the columns it expected and the format that would have worked', () => {
    let message = '';
    try {
      keeperCsvParser.parse(loadFixture('chrome.csv'));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('Website Address');
    expect(message).toContain('Any CSV file');
  });

  it('accepts a mostly-good export with one damaged row instead of refusing the file', () => {
    // The other half of the same rule. "Every row must fit" would refuse a 3,000-record export
    // over one truncated line. Injection: the majority test changed back to `every`. Caught
    // here — the whole file is rejected over the appended row.
    const damaged = `${headerless}one,two,three\n`;
    const parsed = keeperCsvParser.parse(damaged);
    expect(parsed.records.length).toBeGreaterThan(3);
    expect(parsed.warnings.some((warning) => warning.kind === 'ragged-row')).toBe(true);
  });
});

/**
 * The properties `parser-contract.test.ts` will assert automatically once this parser is in the
 * registry. Until then they are asserted here, because a parser nobody has registered yet is
 * exactly the one that ships with a hole in it.
 */
describe('keeper CSV — the parser contract', () => {
  it('survives a BOM, CRLF line endings and a missing trailing newline together', () => {
    for (const fixture of [headed, headerless]) {
      const mangled = withBom(withCrlf(withoutTrailingNewline(fixture)));
      expect(keeperCsvParser.parse(mangled).records).toEqual(
        keeperCsvParser.parse(fixture).records
      );
    }
  });

  it('reads an empty file, and a header with no rows, without throwing', () => {
    expect(keeperCsvParser.parse('').records).toEqual([]);
    const headerOnly = `${headed.split('\n')[0] ?? ''}\n`;
    expect(keeperCsvParser.parse(headerOnly)).toMatchObject({ records: [], folders: [] });
  });

  it('turns a malformed row into a warning rather than an exception', () => {
    const damaged = `${headed}one,two,three\n`;
    const parsed = keeperCsvParser.parse(damaged);
    expect(parsed.records.length).toBeGreaterThan(0);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('never puts a field value in a warning message or a refusal', () => {
    // A property over every value in both fixtures, not a list of known passwords: a list can
    // only catch the leaks somebody already thought of. See the same reasoning in
    // `parser-contract.test.ts`.
    //
    // Injection: a `context.warn` added to the hook echoing the row's notes cell — the shape of
    // "help the user find the row". Caught here, naming the leaked value.
    const sources = [headed, `${headed}one,two,three\n`, headerless, `${headerless}one,two\n`];
    for (const source of sources) {
      const values = valuesOf(source);
      expect(values.length).toBeGreaterThan(3);
      let messages: string[];
      try {
        messages = keeperCsvParser.parse(source).warnings.map((warning) => warning.message);
      } catch (error) {
        messages = [error instanceof Error ? error.message : String(error)];
      }
      for (const message of messages) {
        for (const value of values) {
          expect(message, `leaked "${value}"`).not.toContain(value);
        }
      }
    }
  });

  it('lists every folder its records point at', () => {
    for (const fixture of [headed, headerless]) {
      const parsed = keeperCsvParser.parse(fixture);
      for (const record of parsed.records) {
        if (typeof record.folderId !== 'string') continue;
        expect(parsed.folders).toContain(record.folderId.replace('import-folder:', ''));
      }
    }
  });

  it('gives every record a non-empty title', () => {
    for (const record of [...result.records, ...keeperCsvParser.parse(headerless).records]) {
      expect(record.title.trim()).not.toBe('');
    }
  });

  it('does not throw from detect, whatever it is handed', () => {
    for (const junk of ['', '\0\0\0', '{', 'not,a,real\nfile', '"unclosed']) {
      expect(() => keeperCsvParser.detect(junk)).not.toThrow();
    }
  });
});

/**
 * Every cell value long enough to be recognisable, excluding the header names.
 *
 * Read with `parseCsvRows` rather than `parseCsvTable` on purpose: the table view would treat
 * the headerless fixture's *first record* as a header and quietly drop its values from the
 * check, which is precisely the half of the data this parser is unusual for reading.
 */
function valuesOf(source: string): string[] {
  const headers = new Set(
    (headed.split('\n')[0] ?? '').split(',').map((column) => column.trim().toLowerCase())
  );
  const cells = parseCsvRows(source).rows.flatMap((row) => [...row.cells]);
  return [...new Set(cells)].filter(
    (value) => value.trim().length >= 8 && !headers.has(value.trim().toLowerCase())
  );
}
