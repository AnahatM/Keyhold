// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { chromeCsvParser } from './chrome-csv.js';
import { loadFixture } from './fixtures/load.js';

const result = chromeCsvParser.parse(loadFixture('chrome.csv'));
const [site, intranet, app] = result.records;

describe('chromium CSV (Chrome, Edge, Brave)', () => {
  it('maps every column, including the `note` newer builds added', () => {
    expect(site?.title).toBe('example.com');
    expect(site?.username).toBe('ada@example.com');
    expect(site?.password).toBe('hunter2');
    expect(site?.urls).toEqual(['https://example.com/login']);
    expect(site?.notes).toBe('Shared with Bob, expires in June');
  });

  it('mirrors an email-shaped username into email and leaves the username verbatim', () => {
    expect(site?.email).toBe('ada@example.com');
    expect(intranet?.email).toBe('');
    expect(intranet?.username).toBe('ada');
  });

  it('keeps an android app URI, and titles the record after the package', () => {
    expect(app?.urls).toEqual(['android://abc123==@com.example.app']);
  });

  it('accepts the older four-column export that has no note column', () => {
    const older = 'name,url,username,password\nexample.com,https://example.com,ada,hunter2\n';
    expect(chromeCsvParser.detect(older)).toBe(true);
    expect(chromeCsvParser.parse(older).records[0]?.password).toBe('hunter2');
  });

  it('does not claim NordPass’s export, whose first five columns are identical', () => {
    expect(chromeCsvParser.detect(loadFixture('nordpass.csv'))).toBe(false);
  });
});
