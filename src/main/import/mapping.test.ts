// SPDX-License-Identifier: GPL-3.0-or-later
import { importMatchHost } from '@shared/model/import-plan.js';
import { describe, expect, it } from 'vitest';
import { SECRET_CUSTOM_FIELD_TYPES } from '@shared/model/credential.js';
import { folderAncestors, importFolderPath, normaliseFolderPath } from '@shared/model/import.js';
import {
  addCustom,
  deriveTitle,
  finishDraft,
  FolderSet,
  guessCustomFieldType,
  hostOf,
  isTruthy,
  newDraft,
  splitList,
  splitUrls,
} from './mapping.js';

/**
 * The shared normalisation layer.
 *
 * These tests exist because this module is where **data gets lost or leaked**, and both
 * failures are silent. A wrong `CustomFieldType` on a TOTP seed puts that seed in the safe
 * projection — a security bug reached by a plausible default. A dropped folder path or a
 * missing title is a migration the user has to redo by hand.
 *
 * Fault injection performed: `SECRET_LABEL` narrowed to `/(password|passphrase)/`, the shape a
 * hastily-written version of it would have. Caught — "gives a secret-looking column a secret
 * type" failed on `Recovery key`, which then guessed `text` and would have put a recovery key
 * in the safe projection. Restored.
 *
 * These tests also found a real bug on their first run, before any injection: `Renewal` /
 * `2027-03-01` came back as `phone`, because a loose phone pattern matches an ISO date and the
 * value-shape checks were running ahead of the label checks. `guessCustomFieldType` now does
 * every label check first, and says why.
 */

describe('guessCustomFieldType', () => {
  it('recognises an otpauth URI whatever the column is called', () => {
    expect(guessCustomFieldType('Mystery', 'otpauth://totp/Example?secret=ABC')).toBe('otp-secret');
  });

  it('gives a secret-looking column a secret type', () => {
    // The security-relevant case. Each of these must land on a type that
    // `isCustomFieldValueSecret` treats as secret, or the value reaches the renderer.
    const secretish: [string, string][] = [
      ['OTP', '123456'],
      ['TOTP secret', 'JBSWY3DPEHPK3PXP'],
      ['Support PIN', '8891'],
      ['CVV', '123'],
      ['Recovery key', 'quiet-forest-lantern'],
      ['API key', 'sk-not-a-real-key'],
      ['Backup passphrase', 'correct-horse-battery-staple'],
    ];
    for (const [label, value] of secretish) {
      const type = guessCustomFieldType(label, value);
      expect(SECRET_CUSTOM_FIELD_TYPES, `${label} guessed ${type}`).toContain(type);
    }
  });

  it('does not call an ordinary column secret', () => {
    expect(guessCustomFieldType('Nickname', 'Ada')).toBe('text');
    expect(guessCustomFieldType('Department', 'Engineering')).toBe('text');
  });

  it('reads the value shape when the label says nothing', () => {
    expect(guessCustomFieldType('Contact', 'ada@example.com')).toBe('email');
    expect(guessCustomFieldType('Portal', 'https://example.com')).toBe('url');
    expect(guessCustomFieldType('Reachable on', '+1 555 0100')).toBe('phone');
    expect(guessCustomFieldType('Renewal', '2027-03-01')).toBe('date');
    expect(guessCustomFieldType('Block', 'line one\nline two')).toBe('multiline');
    expect(guessCustomFieldType('Seat count', '42')).toBe('number');
  });
});

describe('value shapes', () => {
  it('splits multiple URLs on newlines only', () => {
    expect(splitUrls('https://a.example.com\nhttps://b.example.com')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
    // A comma inside a URL is legal. Splitting on it would bisect real addresses.
    expect(splitUrls('https://example.com/search?q=a,b')).toEqual([
      'https://example.com/search?q=a,b',
    ]);
  });

  it('splits a list on commas, semicolons and newlines', () => {
    expect(splitList('one, two;three\nfour')).toEqual(['one', 'two', 'three', 'four']);
  });

  it('reads every spelling of true that exports actually use', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'y', 'x', 'on']) {
      expect(isTruthy(value), value).toBe(true);
    }
    for (const value of ['0', 'false', 'no', '', 'maybe']) {
      expect(isTruthy(value), value).toBe(false);
    }
  });

  it('reads a host out of a URL, a bare domain and an android app URI', () => {
    expect(hostOf('https://www.example.com/login')).toBe('example.com');
    expect(hostOf('example.org/path')).toBe('example.org');
    expect(hostOf('android://abc123==@com.example.app')).toBe('com.example.app');
    expect(hostOf('not a url at all')).toBe(null);
    // Identity, not equality. `hostOf` and `importMatchHost` were two behaviourally
    // identical copies, and the copies mattered: one decides whether two records are the
    // same account, the other decides what that account is called. Two answers to "what host
    // is this?" produce an import showing two rows with the same name while insisting they
    // are not duplicates. `toBe` is what makes a re-copy fail here rather than pass.
    expect(hostOf).toBe(importMatchHost);
  });
});

describe('folder paths', () => {
  it('accepts both separators, because LastPass uses the other one', () => {
    expect(normaliseFolderPath('Work\\Clients')).toBe('Work/Clients');
    expect(normaliseFolderPath('Work/Clients')).toBe('Work/Clients');
  });

  it('drops empty segments and stray separators', () => {
    expect(normaliseFolderPath('/Work//Clients/')).toBe('Work/Clients');
    expect(normaliseFolderPath('   ')).toBe(null);
  });

  it('lists ancestors so the caller can create folders in order', () => {
    expect(folderAncestors('A/B/C')).toEqual(['A', 'A/B', 'A/B/C']);
  });

  it('collects a sorted, deduplicated set with every ancestor present', () => {
    const folders = new FolderSet();
    folders.add('Work/Clients');
    folders.add('Work/Clients');
    folders.add('Personal');
    expect(folders.all).toEqual(['Personal', 'Work', 'Work/Clients']);
  });
});

describe('finishDraft', () => {
  it('returns null for a draft with nothing in it', () => {
    expect(finishDraft(newDraft())).toBe(null);
  });

  it('derives a title from the URL host, then the username, then gives up', () => {
    const withUrl = newDraft();
    withUrl.urls.push('https://mail.example.com/inbox');
    expect(deriveTitle(withUrl)).toBe('mail.example.com');

    const withUser = newDraft();
    withUser.username = 'ada';
    expect(deriveTitle(withUser)).toBe('ada');

    const withNothing = newDraft();
    withNothing.password = 'hunter2';
    expect(deriveTitle(withNothing)).toBe('Untitled');
  });

  it('mirrors an email-shaped username into email, and leaves the username verbatim', () => {
    const draft = newDraft();
    draft.username = 'ada@example.com';
    const record = finishDraft(draft);
    expect(record?.username).toBe('ada@example.com');
    expect(record?.email).toBe('ada@example.com');
  });

  it('does not overwrite an email the source gave explicitly', () => {
    const draft = newDraft();
    draft.username = 'ada@example.com';
    draft.email = 'other@example.com';
    expect(finishDraft(draft)?.email).toBe('other@example.com');
  });

  it('leaves a non-email username alone', () => {
    const draft = newDraft();
    draft.username = 'ada';
    expect(finishDraft(draft)?.email).toBe('');
  });

  it('numbers custom fields uniquely within the record', () => {
    const draft = newDraft();
    addCustom(draft, 'One', 'a');
    addCustom(draft, 'Two', 'b');
    const custom = finishDraft(draft)?.custom ?? [];
    expect(custom.map((field) => field.id)).toEqual(['imported-field-1', 'imported-field-2']);
    expect(custom.map((field) => field.order)).toEqual([0, 1]);
  });

  it('skips empty custom values rather than storing blank fields', () => {
    const draft = newDraft();
    draft.title = 'Example';
    addCustom(draft, 'Blank', '   ');
    expect(finishDraft(draft)?.custom).toEqual([]);
  });

  it('points folderId at a placeholder the commit stage can resolve', () => {
    const draft = newDraft();
    draft.title = 'Example';
    draft.folderPath = 'Work/Clients';
    const record = finishDraft(draft);
    expect(record?.folderId).not.toBe(null);
    expect(importFolderPath(record?.folderId ?? '')).toBe('Work/Clients');
  });
});
