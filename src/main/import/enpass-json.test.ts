// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto/errors.js';
import { enpassJsonParser } from './enpass-json.js';
import { loadFixture, withBom, withCrlf, withoutTrailingNewline } from './fixtures/load.js';

/**
 * Enpass JSON field mapping, and the one rule here that is unlike every other importer:
 * **Enpass's `sensitive` flag can override a field's first-class home**, because
 * `username`, `email` and `urls` cross into the renderer and a value the user marked
 * sensitive must not.
 *
 * The contract properties (BOM/CRLF, empty file, malformed item, no value in a warning) are
 * asserted here as well as in `parser-contract.test.ts`. That is deliberate duplication for
 * one release only: this parser is not in `PARSERS` yet, so the table-driven suite does not
 * reach it, and shipping a parser whose contract nobody has checked is how the twelfth parser
 * ends up being the broken one. Once it is registered these can go.
 */

const FIXTURE = loadFixture('enpass.json');
const result = enpassJsonParser.parse(FIXTURE);
const byTitle = (title: string): (typeof result.records)[number] | undefined =>
  result.records.find((record) => record.title === title);

/** The structurally-empty form: the two top-level lists, both empty. */
const EMPTY = '{"folders":[],"items":[]}';

/** The JSON analogue of a ragged row: an item that is not an object at all. */
const DAMAGED = FIXTURE.replace('"items": [', '"items": [\n    "not an item",');

describe('enpass JSON', () => {
  it('maps a login’s typed fields, its two URLs and its TOTP', () => {
    const mail = byTitle('Example Mail');
    expect(mail?.username).toBe('ada@example.com');
    // `finishDraft` mirrors an email-shaped username into `email`; that rule lives in one place.
    expect(mail?.email).toBe('ada@example.com');
    expect(mail?.password).toBe('hunter2');
    expect(mail?.urls).toEqual(['https://mail.example.com', 'https://webmail.example.com']);
    expect(mail?.favorite).toBe(true);
    expect(mail?.notes).toBe('Recovery kit is in the loft, not the cupboard');
  });

  it('keeps a field Enpass marked sensitive out of the safe projection', () => {
    // "Nickname" is an ordinary `text` field with `sensitive: 1`. Guessing from the label would
    // make it plain text, which would put a value the user called sensitive into the projection
    // that crosses to the renderer. Enpass's flag is authoritative.
    const typed = Object.fromEntries(
      byTitle('Example Mail')?.custom?.map((field) => [field.label, field.type]) ?? []
    );
    expect(typed.Nickname).toBe('password');
    expect(typed['One-time code']).toBe('otp-secret');
    expect(typed['Account number']).toBe('number');
  });

  it('does not resurrect a field Enpass tombstoned', () => {
    // Enpass keeps a removed field in the file with `deleted: 1`. Importing one would bring
    // back a value the user deleted — and an old password would come back into the field the
    // health rules read.
    const labels = byTitle('Example Mail')?.custom?.map((field) => field.label) ?? [];
    expect(labels).not.toContain('Old password');
    expect(JSON.stringify(result.records)).not.toContain('hunter1');
    // Skipping it is right, and saying so is still required: "nothing was discarded without
    // telling you" has to hold even when the discard is the correct call.
    expect(result.warnings.map((warning) => warning.message).join(' ')).toContain('tombstones');
  });

  it('ignores a section divider, which has a label and never a value', () => {
    expect(byTitle('Example Mail')?.custom?.map((field) => field.label)).not.toContain('More');
  });

  it('resolves the folder tree through parent_uuid and lists ancestors first', () => {
    expect(result.folders).toEqual(['Work', 'Work/Clients']);
    expect(byTitle('Example Mail')?.folderId).toBe('import-folder:Work/Clients');
    expect(byTitle('Example Card')?.folderId).toBe('import-folder:Work');
  });

  it('imports a card template as custom fields, with the number and code as secret types', () => {
    const typed = Object.fromEntries(
      byTitle('Example Card')?.custom?.map((field) => [field.label, field.type]) ?? []
    );
    // The card number in the fixture carries `sensitive: 0` on purpose, and that is the whole
    // point of this assertion. A fault injection that broke `ENPASS_FIELD_TYPES.ccNumber`
    // originally failed nothing, because the fixture's card number was also flagged sensitive
    // and the `sensitive` override was quietly doing the type table's job. Enpass's flag is
    // set per template field and is not guaranteed on a card number, so the type table has to
    // hold on its own — and now a test says so.
    expect(typed.Number).toBe('password');
    expect(typed.CVC).toBe('pin');
    expect(typed.Cardholder).toBe('text');
    // `05/2030` is not a date, whatever the label says.
    expect(typed['Expiry date']).toBe('text');
    expect(result.warnings.some((warning) => warning.kind === 'unsupported-item')).toBe(true);
  });

  it('imports an archived item rather than hiding it, and says that it did', () => {
    expect(byTitle('Archived Router')?.password).toBe('correct-horse-battery-staple');
    expect(result.warnings.map((warning) => warning.message).join(' ')).toContain('archived');
  });

  it('leaves an item in Enpass’s trash in the trash, and says so', () => {
    expect(byTitle('Deleted Login')).toBeUndefined();
    expect(result.warnings.some((warning) => warning.kind === 'skipped-row')).toBe(true);
  });

  it('refuses a JSON file with no items list rather than importing nothing quietly', () => {
    // The failure this parser exists to make loud. "Imported 0 records, no problems found" on
    // a file that was never an Enpass export is the outcome that costs a user their migration.
    expect(() => enpassJsonParser.parse('{"folders":[]}')).toThrow(/no "items" list/);
  });

  it('refuses an items list holding things that are not Enpass items', () => {
    const wrong = '{"items":[{"name":"Example Mail","secret":"hunter2"}]}';
    expect(() => enpassJsonParser.parse(wrong)).toThrow(/field list or a template/);
  });

  it('throws a VaultError, not a SyntaxError, for a file that is not JSON', () => {
    expect(() => enpassJsonParser.parse('{not json')).toThrow(VaultError);
  });

  it('reads Enpass’s flags whether they are written as 0/1 or as booleans', () => {
    const asBooleans = enpassJsonParser.parse(
      '{"items":[{"title":"Gone","trashed":true,"fields":[{"type":"password","label":"P","value":"x"}]}]}'
    );
    expect(asBooleans.records).toEqual([]);
  });
});

describe('enpass JSON: the parser contract', () => {
  it('survives a BOM, CRLF line endings and a missing trailing newline together', () => {
    const mangled = withBom(withCrlf(withoutTrailingNewline(FIXTURE)));
    expect(enpassJsonParser.parse(mangled).records).toEqual(result.records);
  });

  it('reads a file with no items without throwing', () => {
    const empty = enpassJsonParser.parse(EMPTY);
    expect(empty.records).toEqual([]);
    expect(empty.folders).toEqual([]);
    expect(empty.warnings.some((warning) => warning.kind === 'format')).toBe(true);
  });

  it('turns a malformed item into a warning rather than abandoning the file', () => {
    const salvaged = enpassJsonParser.parse(DAMAGED);
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
      for (const warning of enpassJsonParser.parse(source).warnings) {
        for (const value of values) {
          expect(warning.message, `a warning leaked the value "${value}"`).not.toContain(value);
        }
      }
    }
  });

  it('detects its own fixture and nothing else it might be confused with', () => {
    expect(enpassJsonParser.detect(FIXTURE)).toBe(true);
    for (const other of ['bitwarden.json', 'keyhold.json', 'proton-pass.json', 'dashlane.json']) {
      expect(enpassJsonParser.detect(loadFixture(other)), other).toBe(false);
    }
  });

  it('does not throw from detect, whatever it is handed', () => {
    for (const junk of ['', '\0\0\0', '{', 'not,a,real\nfile', '"unclosed']) {
      expect(() => enpassJsonParser.detect(junk)).not.toThrow();
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
