// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { bitwardenCsvParser, parsePackedFields } from './bitwarden-csv.js';
import { loadFixture } from './fixtures/load.js';

/**
 * Bitwarden CSV field mapping. The shape-of-any-parser cases live in
 * `parser-contract.test.ts`; this file asserts what this format specifically must not lose.
 */

const result = bitwardenCsvParser.parse(loadFixture('bitwarden.csv'));
const [mail, admin, note] = result.records;

describe('bitwarden CSV', () => {
  it('maps the login columns to their Keyhold fields', () => {
    expect(mail?.title).toBe('Example Mail');
    expect(mail?.username).toBe('ada@example.com');
    expect(mail?.password).toBe('hunter2');
    expect(mail?.urls).toEqual(['https://mail.example.com']);
    expect(mail?.favorite).toBe(true);
  });

  it('keeps the notes, comma and all', () => {
    expect(mail?.notes).toBe('Recovery kit is in the safe, not the drawer');
  });

  it('unpacks the packed `fields` cell into typed custom fields', () => {
    // The CSV export flattens every custom field into one cell, losing Bitwarden's own type,
    // so the type is guessed — and guessed towards secrecy for a PIN.
    expect(mail?.custom?.map((field) => [field.label, field.type])).toEqual([
      ['Account number', 'text'],
      ['Support PIN', 'pin'],
      ['One-time password', 'otp-secret'],
    ]);
  });

  it('collapses a multi-URI cell into the urls array', () => {
    expect(admin?.urls).toEqual(['https://admin.example.com', 'https://admin.example.net']);
  });

  it('imports a secure note as a record with notes and no login', () => {
    expect(note?.title).toBe('Wifi Passphrase');
    expect(note?.notes).toBe('SSID: Hazelnut, channel 6');
    expect(note?.password).toBe('');
  });

  it('records the folder tree and points each record at a path in it', () => {
    expect(result.folders).toEqual(['Personal', 'Work', 'Work/Clients']);
    expect(admin?.folderId).toBe('import-folder:Work/Clients');
  });

  it('says that the reprompt flag was not carried, rather than dropping it in silence', () => {
    const dropped = result.warnings.filter((warning) => warning.kind === 'dropped-value');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.column).toBe('reprompt');
  });
});

describe('parsePackedFields', () => {
  it('splits on the first colon, so a value may contain colons of its own', () => {
    expect(parsePackedFields('Endpoint: https://example.com:8443/api')).toEqual([
      ['Endpoint', 'https://example.com:8443/api'],
    ]);
  });

  it('treats a line with no colon as a continuation of the previous value', () => {
    // What a multi-line custom field looks like once Bitwarden has flattened it. Dropping
    // these lines would truncate a block of recovery codes to its first line.
    expect(parsePackedFields('Codes: 1111\n2222\n3333')).toEqual([['Codes', '1111\n2222\n3333']]);
  });

  it('does not invent fields out of blank lines', () => {
    expect(parsePackedFields('\n\n')).toEqual([]);
  });
});
