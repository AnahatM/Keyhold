// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { isCustomFieldValueSecret } from '@shared/model/credential.js';
import { loadFixture } from './fixtures/load.js';
import {
  createGenericCsvParser,
  genericCsvParser,
  inferColumnMapping,
  readCsvColumns,
} from './generic-csv.js';

/**
 * The catch-all, and the most important parser in the registry.
 *
 * Ten named formats cover the managers people are most likely to be leaving. This one covers
 * every manager that exists, including the ones that will never get a parser of their own —
 * so its inference has to be good enough to be useful unaided, and its explicit mapping has
 * to be complete enough for the UI to express anything the inference got wrong.
 *
 * The fixture is a made-up manager's export using none of the standard column names.
 */

const fixture = loadFixture('generic.csv');
const result = genericCsvParser.parse(fixture);
const [hosting, registrar] = result.records;

describe('inferColumnMapping', () => {
  it('recognises the common synonyms for each field', () => {
    const mapping = inferColumnMapping(readCsvColumns(fixture));
    expect(mapping.columns).toMatchObject({
      entry: 'title',
      'web site': 'url',
      login: 'username',
      secret: 'password',
      category: 'folder',
      comment: 'notes',
    });
  });

  it('sends anything it does not recognise to a custom field, never to a drop', () => {
    // A wrong guess towards `custom` costs one dropdown change. A wrong guess towards `drop`
    // costs a column the user may not notice is gone until the old manager is cancelled.
    const mapping = inferColumnMapping(readCsvColumns(fixture));
    expect(mapping.columns['account number']).toBe('custom');
    expect(mapping.columns['support pin']).toBe('custom');
    expect(Object.values(mapping.columns)).not.toContain('drop');
  });

  it('does not let a second column overwrite a single-valued field', () => {
    // A file with both `name` and `title` should keep the first and surface the second, not
    // silently let one win.
    const mapping = inferColumnMapping(['title', 'name', 'url', 'urls']);
    expect(mapping.columns.title).toBe('title');
    expect(mapping.columns.name).toBe('custom');
    // `url` accumulates, so a second URL column is not a conflict at all.
    expect(mapping.columns.urls).toBe('url');
  });

  it('ignores case and surrounding space in a header', () => {
    expect(inferColumnMapping([' Login Name ']).columns['login name']).toBe('username');
  });
});

describe('the inferred parser', () => {
  it('maps an unfamiliar export into the right fields', () => {
    expect(hosting?.title).toBe('Example Hosting');
    expect(hosting?.username).toBe('ada@example.com');
    expect(hosting?.password).toBe('hunter2');
    expect(hosting?.urls).toEqual(['https://hosting.example.com']);
    expect(hosting?.notes).toBe('Billed annually, purchase order required');
    expect(hosting?.folderId).toBe('import-folder:Work/Suppliers');
    expect(registrar?.folderId).toBe('import-folder:Work');
  });

  it('gives a secret-looking unmapped column a secret type', () => {
    const pin = hosting?.custom?.find((field) => field.label === 'Support PIN');
    expect(pin?.type).toBe('pin');
    expect(isCustomFieldValueSecret(pin ?? { type: 'text', hidden: false })).toBe(true);
  });

  it('types the other unmapped columns from their labels and values', () => {
    const typed = Object.fromEntries(hosting?.custom?.map((f) => [f.label, f.type]) ?? []);
    expect(typed['Contract Renewal']).toBe('date');
    expect(typed['Account Number']).toBe('text');
  });

  it('says which columns it guessed at, by name, once each', () => {
    // The inference made a decision the user did not make. Not saying so would hide it; saying
    // so per row would bury it.
    const unmapped = result.warnings.filter((warning) => warning.kind === 'unmapped-column');
    expect(unmapped.map((warning) => warning.column)).toEqual([
      'Account Number',
      'Support PIN',
      'Contract Renewal',
    ]);
  });
});

describe('an explicit mapping, as the mapping UI produces one', () => {
  const parser = createGenericCsvParser({
    columns: {
      entry: 'title',
      'web site': 'url',
      login: 'email',
      secret: 'password',
      category: 'tags',
      comment: 'ignore',
      'account number': 'custom',
      'support pin': 'drop',
      'contract renewal': 'custom',
    },
    customTypes: { 'account number': 'number' },
    customLabels: { 'account number': 'Customer reference' },
  });

  const mapped = parser.parse(fixture);
  const [first] = mapped.records;

  it('honours the user’s choices over the inference', () => {
    expect(first?.email).toBe('ada@example.com');
    expect(first?.username).toBe('');
    expect(first?.tags).toEqual(['Work/Suppliers']);
    expect(first?.folderId).toBe(null);
  });

  it('honours an explicit type and label override', () => {
    expect(first?.custom?.[0]).toMatchObject({ label: 'Customer reference', type: 'number' });
  });

  it('says nothing about columns the user deliberately mapped to custom', () => {
    // The user made this decision. Warning about it would be noise, and noise is what makes a
    // warning list go unread.
    expect(mapped.warnings.filter((warning) => warning.kind === 'unmapped-column')).toEqual([]);
  });

  it('still reports a column the user chose to drop', () => {
    const dropped = mapped.warnings.filter((warning) => warning.kind === 'dropped-value');
    expect(dropped.map((warning) => warning.column)).toEqual(['Support PIN']);
  });

  it('is never auto-suggested, because its mapping belongs to one particular file', () => {
    expect(parser.detect(fixture)).toBe(false);
  });
});

describe('detection', () => {
  it('claims anything that reads as a delimited table', () => {
    expect(genericCsvParser.detect('a,b\n1,2\n')).toBe(true);
  });

  it('does not claim a binary file', () => {
    expect(genericCsvParser.detect('PNG\r\n\n\0\0\0IHDR')).toBe(false);
  });

  it('does not claim a single-column file, which is a list rather than a table', () => {
    expect(genericCsvParser.detect('just one column\nvalue\n')).toBe(false);
  });
});
