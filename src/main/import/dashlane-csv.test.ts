// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { dashlaneCsvParser } from './dashlane-csv.js';
import { loadFixture } from './fixtures/load.js';

const result = dashlaneCsvParser.parse(loadFixture('dashlane.csv'));
const [mail, forum] = result.records;

describe('dashlane CSV', () => {
  it('maps the credentials columns', () => {
    expect(mail?.title).toBe('Example Mail');
    expect(mail?.username).toBe('ada@example.com');
    expect(mail?.password).toBe('hunter2');
    expect(mail?.urls).toEqual(['https://mail.example.com']);
    expect(mail?.notes).toBe('Shared with the team, rotate quarterly');
  });

  it('keeps the alternate logins instead of picking one and losing the rest', () => {
    // Which of three logins a site actually wants is a fact only the user knows. Merging them
    // into `username` would silently discard two of them.
    expect(mail?.custom?.[0]).toMatchObject({
      label: 'Alternate login',
      value: 'ada.lovelace@example.com',
    });
  });

  it('turns `category` into a folder', () => {
    expect(mail?.folderId).toBe('import-folder:Work');
    expect(forum?.folderId).toBe('import-folder:Personal');
    expect(result.folders).toEqual(['Personal', 'Work']);
  });

  it('reads the TOTP seed from either column name Dashlane uses', () => {
    expect(mail?.custom?.[1]).toMatchObject({ type: 'otp-secret', value: 'JBSWY3DPEHPK3PXP' });

    const withOtpUrl =
      'username,username2,username3,title,password,note,url,category,otpUrl\n' +
      'ada,,,Example,hunter2,,https://example.com,Work,otpauth://totp/Example?secret=ABC\n';
    expect(dashlaneCsvParser.parse(withOtpUrl).records[0]?.custom?.[0]?.type).toBe('otp-secret');
  });
});
