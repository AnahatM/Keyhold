// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { isCustomFieldValueSecret } from '@shared/model/credential.js';
import { loadFixture } from './fixtures/load.js';
import { nordpassCsvParser } from './nordpass-csv.js';

const result = nordpassCsvParser.parse(loadFixture('nordpass.csv'));
const [mail, card, identity] = result.records;

describe('nordpass CSV', () => {
  it('maps a login row', () => {
    expect(mail?.title).toBe('Example Mail');
    expect(mail?.username).toBe('ada@example.com');
    expect(mail?.password).toBe('hunter2');
    expect(mail?.notes).toBe('Recovery address is bob@example.com, not mine');
    expect(mail?.folderId).toBe('import-folder:Personal');
  });

  it('gives the card number and CVC secret types, so neither reaches the renderer', () => {
    // The security-relevant assertion in this file. The type guesser sees a run of digits and
    // says `number`, which would put a live card number in the safe projection — a real leak
    // arrived at through an entirely plausible default.
    const typed = card?.custom?.filter((field) => ['Card number', 'CVC'].includes(field.label));
    expect(typed).toHaveLength(2);
    for (const field of typed ?? []) {
      expect(isCustomFieldValueSecret(field), `${field.label} is not secret`).toBe(true);
    }
  });

  it('labels the card columns readably rather than leaving the raw header', () => {
    expect(card?.custom?.map((field) => field.label)).toEqual([
      'Cardholder name',
      'Card number',
      'CVC',
      'Expiry date',
      'Postcode',
    ]);
  });

  it('imports an identity row without a login, keeping its address fields', () => {
    expect(identity?.email).toBe('ada@example.com');
    expect(identity?.password).toBe('');
    const typed = Object.fromEntries(identity?.custom?.map((f) => [f.label, f.type]) ?? []);
    expect(typed['Phone number']).toBe('phone');
    expect(typed.Address).toBe('address');
    expect(typed.City).toBe('text');
  });

  it('does not treat empty card columns on a login row as fields', () => {
    expect(mail?.custom).toEqual([]);
  });
});
