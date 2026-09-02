// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { loadFixture } from './fixtures/load.js';
import { lastpassCsvParser } from './lastpass-csv.js';

const result = lastpassCsvParser.parse(loadFixture('lastpass.csv'));
const [shop, note, bank] = result.records;

describe('lastpass CSV', () => {
  it('maps `extra` to notes — the column third-party importers most often drop', () => {
    expect(shop?.notes).toBe('Delivery address: 12 High Street, Springfield');
  });

  it('maps the login columns and the favourite flag', () => {
    expect(shop?.title).toBe('Example Shop');
    expect(shop?.username).toBe('ada@example.com');
    expect(shop?.password).toBe('hunter2');
    expect(shop?.favorite).toBe(true);
  });

  it('nests `grouping` on its backslash, like every other manager’s slash', () => {
    expect(note?.folderId).toBe('import-folder:Work/Infrastructure');
    expect(result.folders).toContain('Work');
    expect(result.folders).toContain('Work/Infrastructure');
  });

  it('does not store LastPass’s `http://sn` sentinel as a real URL', () => {
    // Left alone this becomes a credential pointing at a host called "sn", which then shows up
    // in the URL column of the record list and in every future domain match.
    expect(note?.urls).toEqual([]);
    expect(note?.title).toBe('Build Server');
  });

  it('keeps a structured note verbatim and says it did', () => {
    expect(note?.notes).toContain('Hostname:build.example.com');
    expect(result.warnings.some((warning) => warning.kind === 'unsupported-item')).toBe(true);
  });

  it('carries a bare TOTP seed into a secret-typed custom field', () => {
    expect(bank?.custom?.[0]).toMatchObject({
      label: 'One-time password',
      type: 'otp-secret',
      value: 'JBSWY3DPEHPK3PXP',
    });
  });
});
