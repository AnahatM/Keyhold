// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto/errors.js';
import { dashlaneJsonParser } from './dashlane-json.js';
import { loadFixture, withBom, withCrlf, withoutTrailingNewline } from './fixtures/load.js';

/**
 * Dashlane JSON field mapping.
 *
 * The difference from `dashlane-csv.ts` that justifies a second Dashlane parser: the CSV
 * export is five files and this parser's source is one, so **everything that is not a login
 * is here too** — notes, cards, ID documents. An importer that read `AUTHENTIFIANT` and
 * stopped would silently discard all of it, so most of what follows is about the other
 * sections.
 *
 * The contract properties (BOM/CRLF, empty file, malformed item, no value in a warning) are
 * asserted here as well as in `parser-contract.test.ts`. That is deliberate duplication for
 * one release only: this parser is not in `PARSERS` yet, so the table-driven suite does not
 * reach it, and shipping a parser whose contract nobody has checked is how the twelfth parser
 * ends up being the broken one. Once it is registered these can go.
 */

const FIXTURE = loadFixture('dashlane.json');
const result = dashlaneJsonParser.parse(FIXTURE);
const byTitle = (title: string): (typeof result.records)[number] | undefined =>
  result.records.find((record) => record.title === title);
const typesOf = (title: string): Record<string, string> =>
  Object.fromEntries(byTitle(title)?.custom?.map((field) => [field.label, field.type]) ?? []);

/** The structurally-empty form: the two sections that matter, both empty. */
const EMPTY = '{"AUTHENTIFIANT":[],"SECURENOTE":[]}';

/** The JSON analogue of a ragged row: an item that is not an object at all. */
const DAMAGED = FIXTURE.replace('"AUTHENTIFIANT": [', '"AUTHENTIFIANT": [\n    "not an item",');

describe('dashlane JSON', () => {
  it('maps a login, keeping its email and username apart', () => {
    const mail = byTitle('Example Mail');
    expect(mail?.username).toBe('ada');
    expect(mail?.email).toBe('ada@example.com');
    expect(mail?.password).toBe('hunter2');
    expect(mail?.urls).toEqual(['https://mail.example.com']);
    expect(mail?.notes).toBe('Renewal is in March, not January');
  });

  it('keeps the alternate login as its own field instead of choosing for the user', () => {
    // Which login a site actually wants is a fact only the user knows. Same label and type as
    // `dashlane-csv.ts` produces, so the two Dashlane paths agree.
    const alternate = byTitle('Example Mail')?.custom?.find(
      (field) => field.label === 'Alternate login'
    );
    expect(alternate).toMatchObject({ value: 'ada.lovelace@example.com', type: 'text' });
  });

  it('prefers the full otpauth URI over the bare seed, and takes the seed when that is all there is', () => {
    expect(typesOf('Example Mail')['One-time password']).toBe('otp-secret');
    const admin = byTitle('Example Admin')?.custom?.find(
      (field) => field.label === 'One-time password'
    );
    expect(admin?.value.startsWith('otpauth://')).toBe(true);
  });

  it('does not give one login two URLs that differ only in their scheme', () => {
    // `domain` is Dashlane's parsed host for the same site as `url`. Taking both would make the
    // dedupe rule see two hosts where the user has one account.
    expect(byTitle('Example Admin')?.urls).toEqual(['https://admin.example.com']);
  });

  it('turns a category into a folder and lists them for the caller to create', () => {
    expect(result.folders).toEqual(['Personal', 'Work']);
    expect(byTitle('Example Mail')?.folderId).toBe('import-folder:Personal');
    expect(byTitle('Example Admin')?.folderId).toBe('import-folder:Work');
  });

  it('imports a secure note and names the protection flag it cannot carry', () => {
    expect(byTitle('Wifi Passphrase')?.notes).toBe('SSID is Hazelnut on channel 6');
    expect(result.warnings.map((warning) => warning.message).join(' ')).toContain('protected');
  });

  it('imports the payment section, with the card number and security code as secret types', () => {
    const typed = typesOf('Example Card');
    expect(typed['Card number']).toBe('password');
    expect(typed['Security code']).toBe('pin');
    expect(typed.Bank).toBe('text');
  });

  it('imports an ID document, treating its number as secret', () => {
    const typed = typesOf('Ada Lovelace');
    expect(typed.Number).toBe('password');
    expect(typed['Date of birth']).toBe('date');
  });

  it('imports a section it has never heard of rather than dropping it', () => {
    // The stand-in for "Dashlane shipped a new section after this was written". Losing a whole
    // section silently is the failure this parser is shaped to avoid.
    const membership = byTitle('Example Loyalty Scheme');
    expect(membership).toBeDefined();
    expect(typesOf('Example Loyalty Scheme').Number).toBe('password');
  });

  it('names every non-login section by its own name, which is Dashlane’s and not the user’s', () => {
    const messages = result.warnings.map((warning) => warning.message).join(' ');
    expect(messages).toContain('Credit card');
    expect(messages).toContain('ID card');
    expect(messages).toContain('Membership');
  });

  it('does not import a category list as if it were a credential', () => {
    // `AUTHCATEGORY` holds folder names, and every one of them already arrives as a folder.
    // Importing it would produce a credential called "Work" whose only content is "Work".
    expect(byTitle('Work')).toBeUndefined();
    expect(byTitle('Personal')).toBeUndefined();
    expect(result.records).toHaveLength(6);
  });

  it('says once that Dashlane’s own bookkeeping did not come across', () => {
    const bookkeeping = result.warnings.filter((warning) =>
      warning.message.includes('bookkeeping')
    );
    expect(bookkeeping).toHaveLength(1);
  });

  it('refuses a JSON file with no item lists rather than importing nothing quietly', () => {
    // The failure this parser exists to make loud. "Imported 0 records, no problems found" on
    // a file that was never a Dashlane export is the outcome that costs a user their migration.
    expect(() => dashlaneJsonParser.parse('{"version":1}')).toThrow(/no item lists/);
  });

  it('refuses item lists that are not Dashlane sections', () => {
    expect(() => dashlaneJsonParser.parse('{"logins":[{"title":"Example Mail"}]}')).toThrow(
      /section Dashlane writes/
    );
  });

  it('throws a VaultError, not a SyntaxError, for a file that is not JSON', () => {
    expect(() => dashlaneJsonParser.parse('{not json')).toThrow(VaultError);
  });
});

describe('dashlane JSON: the parser contract', () => {
  it('survives a BOM, CRLF line endings and a missing trailing newline together', () => {
    const mangled = withBom(withCrlf(withoutTrailingNewline(FIXTURE)));
    expect(dashlaneJsonParser.parse(mangled).records).toEqual(result.records);
  });

  it('reads a file with no items without throwing', () => {
    const empty = dashlaneJsonParser.parse(EMPTY);
    expect(empty.records).toEqual([]);
    expect(empty.folders).toEqual([]);
    expect(empty.warnings.some((warning) => warning.kind === 'format')).toBe(true);
  });

  it('turns a malformed item into a warning rather than abandoning the file', () => {
    const salvaged = dashlaneJsonParser.parse(DAMAGED);
    expect(salvaged.records.length).toBeGreaterThan(0);
    expect(salvaged.warnings.some((warning) => warning.kind === 'skipped-row')).toBe(true);
  });

  it('lists every folder its records point at', () => {
    for (const record of result.records) {
      if (typeof record.folderId !== 'string') continue;
      expect(result.folders).toContain(record.folderId.replace('import-folder:', ''));
    }
  });

  it('never puts a field value in a warning message', () => {
    // A property over *every* string in the fixture, not a list of known passwords. A
    // hand-written list of secrets can only catch the leaks someone already thought of.
    const values = stringLeaves(FIXTURE).filter((value) => value.trim().length >= 8);
    expect(values.length).toBeGreaterThan(3);

    for (const source of [FIXTURE, DAMAGED, EMPTY]) {
      for (const warning of dashlaneJsonParser.parse(source).warnings) {
        for (const value of values) {
          expect(warning.message, `a warning leaked the value "${value}"`).not.toContain(value);
        }
      }
    }
  });

  it('detects its own fixture and nothing else it might be confused with', () => {
    expect(dashlaneJsonParser.detect(FIXTURE)).toBe(true);
    for (const other of ['bitwarden.json', 'keyhold.json', 'proton-pass.json', 'enpass.json']) {
      expect(dashlaneJsonParser.detect(loadFixture(other)), other).toBe(false);
    }
  });

  it('does not throw from detect, whatever it is handed', () => {
    for (const junk of ['', '\0\0\0', '{', 'not,a,real\nfile', '"unclosed']) {
      expect(() => dashlaneJsonParser.detect(junk)).not.toThrow();
    }
  });
});

function stringLeaves(fixture: string): string[] {
  const leaves: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') leaves.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (typeof node === 'object' && node !== null) Object.values(node).forEach(walk);
  };
  walk(JSON.parse(fixture));
  return [...new Set(leaves)];
}
