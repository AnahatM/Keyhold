// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { loadFixture } from './fixtures/load.js';
import { onePasswordCsvParser } from './onepassword-csv.js';

const result = onePasswordCsvParser.parse(loadFixture('onepassword.csv'));
const [mail, forum] = result.records;

describe('1password CSV', () => {
  it('maps the login columns and the OTP URI', () => {
    expect(mail?.title).toBe('Example Mail');
    expect(mail?.username).toBe('ada@example.com');
    expect(mail?.password).toBe('hunter2');
    expect(mail?.urls).toEqual(['https://mail.example.com']);
    expect(mail?.custom?.[0]?.type).toBe('otp-secret');
  });

  it('splits the Tags cell into real tags', () => {
    expect(mail?.tags).toEqual(['personal', 'email']);
    expect(forum?.tags).toEqual(['personal']);
  });

  it('honours Favorite', () => {
    expect(mail?.favorite).toBe(true);
    expect(forum?.favorite).toBe(false);
  });

  it('leaves an archived item out, and says which line it skipped', () => {
    // An archived item is one the user has already decided they are done with. Reviving it
    // into the active list is a mess they then have to clean up by hand.
    expect(result.records.map((record) => record.title)).toEqual(['Example Mail', 'Example Forum']);
    const skipped = result.warnings.filter((warning) => warning.kind === 'skipped-row');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.line).toBe(4);
  });

  it('keeps the notes column, comma and all', () => {
    expect(mail?.notes).toBe('Security question: first pet, answered in the safe');
  });
});
