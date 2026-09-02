// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { loadFixture } from './fixtures/load.js';
import { firefoxCsvParser } from './firefox-csv.js';

const result = firefoxCsvParser.parse(loadFixture('firefox.csv'));
const [site, router] = result.records;

describe('firefox CSV', () => {
  it('gives every record a title even though the format has no title column', () => {
    // Without derivation this import produces a vault of entries all called "Untitled", which
    // is the single most common complaint about Firefox imports elsewhere.
    expect(site?.title).toBe('example.com');
    expect(router?.title).toBe('router.example.net');
    expect(result.warnings.filter((warning) => warning.kind === 'derived-value')).toHaveLength(2);
  });

  it('maps the credential columns', () => {
    expect(site?.username).toBe('ada@example.com');
    expect(site?.password).toBe('hunter2');
    expect(site?.urls).toEqual(['https://example.com']);
  });

  it('keeps httpRealm as a custom field rather than discarding it', () => {
    expect(router?.custom?.[0]).toMatchObject({
      label: 'httpRealm',
      value: 'Example Router, admin realm',
    });
  });

  it('names each timestamp column it drops, and why', () => {
    const dropped = result.warnings.filter((warning) => warning.kind === 'dropped-value');
    expect(dropped.map((warning) => warning.column)).toEqual([
      'guid',
      'timeCreated',
      'timeLastUsed',
      'timePasswordChanged',
    ]);
    expect(dropped[1]?.message).toContain('dated at the time of the import');
  });

  it('reports the columns it had no home for by name', () => {
    const unmapped = result.warnings.filter((warning) => warning.kind === 'unmapped-column');
    expect(unmapped.map((warning) => warning.column).sort()).toEqual([
      'formActionOrigin',
      'httpRealm',
    ]);
  });
});
