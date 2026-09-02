// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { loadFixture } from './fixtures/load.js';
import { safariCsvParser } from './safari-csv.js';

const result = safariCsvParser.parse(loadFixture('safari.csv'));
const [mail, forum] = result.records;

describe('safari / apple passwords CSV', () => {
  it('maps every column', () => {
    expect(mail?.title).toBe('Example Mail');
    expect(mail?.username).toBe('ada@example.com');
    expect(mail?.password).toBe('hunter2');
    expect(mail?.urls).toEqual(['https://mail.example.com']);
    expect(mail?.notes).toBe('Backup codes: 1111, 2222, 3333');
    expect(forum?.custom).toEqual([]);
  });

  it('keeps the whole otpauth URI, not just the seed', () => {
    // The URI carries the issuer, account, digit count and period. Reducing it to the seed
    // throws away everything a generator needs to reproduce Apple's codes.
    expect(mail?.custom?.[0]).toMatchObject({ label: 'One-time password', type: 'otp-secret' });
    expect(mail?.custom?.[0]?.value).toContain('issuer=Example');
  });

  it('accepts the older export that stops at Notes', () => {
    const older = 'Title,URL,Username,Password,Notes\nExample,https://example.com,ada,hunter2,\n';
    expect(safariCsvParser.detect(older)).toBe(true);
  });

  it('does not claim 1Password’s export, which is a superset of these columns', () => {
    expect(safariCsvParser.detect(loadFixture('onepassword.csv'))).toBe(false);
  });
});
