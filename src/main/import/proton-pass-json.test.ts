// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto/errors.js';
import { loadFixture, withBom, withCrlf, withoutTrailingNewline } from './fixtures/load.js';
import { protonPassJsonParser } from './proton-pass-json.js';

/**
 * Proton Pass JSON field mapping, and the two shapes it refuses.
 *
 * The interesting differences from the other JSON importers are that **vaults become folders**
 * — Proton has no folder tree at all — and that Proton keeps the login's email and username
 * genuinely apart, so neither has to be guessed at.
 *
 * The contract properties (BOM/CRLF, empty file, malformed item, no value in a warning) are
 * asserted here as well as in `parser-contract.test.ts`. That is deliberate duplication for
 * one release only: this parser is not in `PARSERS` yet, so the table-driven suite does not
 * reach it, and shipping a parser whose contract nobody has checked is how the twelfth parser
 * ends up being the broken one. Once it is registered these can go.
 */

const FIXTURE = loadFixture('proton-pass.json');
const result = protonPassJsonParser.parse(FIXTURE);
const byTitle = (title: string): (typeof result.records)[number] | undefined =>
  result.records.find((record) => record.title === title);

/** The structurally-empty form: a real vault holding no items. */
const EMPTY = '{"encrypted":false,"vaults":{"share-1":{"name":"Personal","items":[]}}}';

/** The JSON analogue of a ragged row: an item that is not an object at all. */
const DAMAGED = FIXTURE.replace('"items": [', '"items": [\n        "not an item",');

describe('proton pass JSON', () => {
  it('maps a login, its two URLs, its TOTP and the pin that makes it a favourite', () => {
    const mail = byTitle('Example Mail');
    expect(mail?.email).toBe('ada@example.com');
    expect(mail?.username).toBe('ada');
    expect(mail?.password).toBe('hunter2');
    expect(mail?.urls).toEqual(['https://mail.example.com', 'https://webmail.example.com']);
    expect(mail?.favorite).toBe(true);
    expect(mail?.notes).toBe('Backup phrase is in the safe, not the drawer');
    expect(mail?.custom?.[0]).toMatchObject({ label: 'One-time password', type: 'otp-secret' });
  });

  it('trusts Proton’s own field type for a hidden extra field instead of re-guessing it', () => {
    // A hidden field is secret because Proton says so. Guessing from the label would call
    // "Support PIN" a pin, which is also secret — but a hidden field named "Nickname" would
    // come out as plain text and reach the renderer.
    const typed = Object.fromEntries(
      byTitle('Example Mail')?.custom?.map((field) => [field.label, field.type]) ?? []
    );
    expect(typed['Support PIN']).toBe('password');
    expect(typed['Account number']).toBe('text');
    expect(typed['Backup authenticator']).toBe('otp-secret');
  });

  it('reads a login written before Proton split username from email', () => {
    // Older exports carry a single `username`. `finishDraft` leaves `email` empty here because
    // "admin" is not email-shaped, which is the correct outcome and not an oversight.
    const admin = byTitle('Example Admin');
    expect(admin?.username).toBe('admin');
    expect(admin?.email).toBe('');
    expect(admin?.password).toBe('correct-horse-battery-staple');
  });

  it('turns each vault into a folder and lists them for the caller to create', () => {
    expect(result.folders).toEqual(['Personal', 'Work Clients']);
    expect(byTitle('Example Mail')?.folderId).toBe('import-folder:Personal');
    expect(byTitle('Example Card')?.folderId).toBe('import-folder:Work Clients');
  });

  it('keeps an alias’s forwarding address as the record’s email, and says what it cannot keep', () => {
    expect(byTitle('Shopping Alias')?.email).toBe('ada.shopping@passinbox.example');
    expect(result.warnings.map((warning) => warning.message).join(' ')).toContain('aliases');
  });

  it('imports a card as custom fields, with the number, code and pin as secret types', () => {
    const typed = Object.fromEntries(
      byTitle('Example Card')?.custom?.map((field) => [field.label, field.type]) ?? []
    );
    expect(typed['Card number']).toBe('password');
    expect(typed['Security code']).toBe('pin');
    expect(typed.PIN).toBe('pin');
    // `052030` is not a date, whatever the label says. Rendering it through a date formatter
    // would produce something that is not the card's expiry.
    expect(typed['Expiry date']).toBe('text');
  });

  it('carries an item type it has never seen rather than dropping it', () => {
    // The SSH key is the stand-in for "Proton shipped a new item type after this was written".
    const typed = Object.fromEntries(
      byTitle('Deploy Key')?.custom?.map((field) => [field.label, field.type]) ?? []
    );
    expect(typed['Private key']).toBe('password');
    expect(typed['Public key']).toBe('text');
  });

  it('names the numeric content key it could not carry rather than inventing a value', () => {
    // `cardType` is a numeric enum. "Card type: 1" in a vault looks like data and is not.
    const warning = result.warnings.find((entry) => entry.column === 'Card type');
    expect(warning?.kind).toBe('dropped-value');
    expect(warning?.message).toContain('not text');
  });

  it('leaves an item in Proton’s trash in the trash, and says so', () => {
    expect(byTitle('Deleted Login')).toBeUndefined();
    expect(result.warnings.some((warning) => warning.kind === 'skipped-row')).toBe(true);
  });

  it('names the passkey it cannot carry', () => {
    expect(result.warnings.map((warning) => warning.message).join(' ')).toContain('passkey');
  });

  it('refuses an encrypted export and says which option to change', () => {
    // The one case where throwing is right: there is no partial answer to give.
    expect(() => protonPassJsonParser.parse('{"encrypted":true,"vaults":{}}')).toThrow(VaultError);
    expect(() => protonPassJsonParser.parse('{"encrypted":true,"vaults":{}}')).toThrow(/PGP/);
  });

  it('refuses a JSON file with no vaults section rather than importing nothing quietly', () => {
    // The failure this parser exists to make loud. "Imported 0 records, no problems found" on
    // a file that was never a Proton export is the outcome that costs a user their migration.
    expect(() => protonPassJsonParser.parse('{"items":[]}')).toThrow(/no "vaults" section/);
  });

  it('refuses a vaults section whose vaults have no items list', () => {
    const wrong = '{"vaults":{"a":{"name":"Personal","entries":[]}}}';
    expect(() => protonPassJsonParser.parse(wrong)).toThrow(/"items" list/);
  });

  it('throws a VaultError, not a SyntaxError, for a file that is not JSON', () => {
    expect(() => protonPassJsonParser.parse('{not json')).toThrow(VaultError);
    // The zip is the thing a user will actually pick, so the message names the file inside it.
    expect(() => protonPassJsonParser.parse('PK\u0003\u0004')).toThrow(/data\.json/);
  });
});

describe('proton pass JSON: the parser contract', () => {
  it('survives a BOM, CRLF line endings and a missing trailing newline together', () => {
    const mangled = withBom(withCrlf(withoutTrailingNewline(FIXTURE)));
    expect(protonPassJsonParser.parse(mangled).records).toEqual(result.records);
  });

  it('reads a file with no items without throwing', () => {
    const empty = protonPassJsonParser.parse(EMPTY);
    expect(empty.records).toEqual([]);
    expect(empty.folders).toEqual([]);
    expect(empty.warnings.some((warning) => warning.kind === 'format')).toBe(true);
  });

  it('turns a malformed item into a warning rather than abandoning the file', () => {
    const salvaged = protonPassJsonParser.parse(DAMAGED);
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
      for (const warning of protonPassJsonParser.parse(source).warnings) {
        for (const value of values) {
          expect(warning.message, `a warning leaked the value "${value}"`).not.toContain(value);
        }
      }
    }
  });

  it('detects its own fixture and nothing else it might be confused with', () => {
    expect(protonPassJsonParser.detect(FIXTURE)).toBe(true);
    for (const other of ['bitwarden.json', 'keyhold.json', 'enpass.json', 'dashlane.json']) {
      expect(protonPassJsonParser.detect(loadFixture(other)), other).toBe(false);
    }
  });

  it('does not throw from detect, whatever it is handed', () => {
    for (const junk of ['', '\0\0\0', '{', 'not,a,real\nfile', '"unclosed']) {
      expect(() => protonPassJsonParser.detect(junk)).not.toThrow();
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
