// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Credential } from '@shared/model/credential.js';
import { importFolderId } from '@shared/model/import.js';
import type { NewCredentialInput } from '../vault/credential-ops.js';
import { planMerge, PREVIEW_MERGE_CONTEXT, type MergeContext } from './merge.js';
import { FakeVault } from './test-support.js';

/**
 * The merge policy, asserted directly.
 *
 * `planMerge` returns the description and the patch together precisely so the two cannot
 * disagree, and every case here checks both halves — the effect the review screen would show
 * *and* the change the write would make. A test that only checked the effects would pass on
 * the day they stopped describing the patch, which is the failure this design exists to
 * prevent.
 */

let ids = 0;
const context: MergeContext = {
  newId: () => `merged-${(ids += 1)}`,
  folderIdFor: (path) => (path === 'Work' ? 'folder-work' : null),
};

function existing(overrides: Partial<NewCredentialInput> = {}): Credential {
  return new FakeVault().seed({
    title: 'GitHub',
    username: 'octocat',
    email: 'octocat@example.com',
    password: 'current',
    urls: ['https://github.com'],
    notes: 'my notes',
    tags: ['dev'],
    ...overrides,
  });
}

function incoming(overrides: Partial<NewCredentialInput> = {}): NewCredentialInput {
  return { title: 'GitHub', ...overrides };
}

describe('planMerge', () => {
  it('fills a field the vault left empty', () => {
    const result = planMerge(
      existing({ email: '' }),
      [incoming({ email: 'new@example.com' })],
      context
    );

    expect(result.fields).toContainEqual({ field: 'email', effect: 'fills-empty' });
    expect(result.patch.fields?.email).toBe('new@example.com');
  });

  it('replaces a field the vault already had, and says so', () => {
    const result = planMerge(existing(), [incoming({ password: 'from-the-file' })], context);

    expect(result.fields).toContainEqual({ field: 'password', effect: 'replaces' });
    expect(result.patch.fields?.password).toBe('from-the-file');
  });

  it('leaves a field alone when the file has nothing for it', () => {
    const result = planMerge(existing(), [incoming({ password: '' })], context);

    expect(result.fields.map((field) => field.field)).not.toContain('password');
    expect(result.patch.fields?.password).toBeUndefined();
  });

  it('leaves a field alone when the file agrees with the vault', () => {
    const result = planMerge(existing(), [incoming({ password: 'current' })], context);
    expect(result.fields).toEqual([]);
  });

  it('adds urls, tags and custom fields without removing any', () => {
    const result = planMerge(
      existing(),
      [
        incoming({
          urls: ['https://github.com', 'https://gist.github.com'],
          tags: ['dev', 'work'],
          custom: [
            {
              id: 'imported-field-1',
              label: 'Recovery',
              type: 'text',
              value: 'x',
              hidden: false,
              order: 0,
            },
          ],
        }),
      ],
      context
    );

    expect(result.fields).toContainEqual({ field: 'urls', effect: 'adds' });
    expect(result.fields).toContainEqual({ field: 'tags', effect: 'adds' });
    expect(result.fields).toContainEqual({ field: 'custom', effect: 'adds' });
    expect(result.patch.fields?.urls).toEqual(['https://github.com', 'https://gist.github.com']);
    expect(result.patch.tags).toEqual(['dev', 'work']);
    expect(result.patch.fields?.custom?.map((field) => field.label)).toEqual(['Recovery']);
    // A fresh id, not the parser's record-scoped one: reveal addresses a value by field id.
    expect(result.patch.fields?.custom?.[0]?.id).not.toBe('imported-field-1');
  });

  it('does not add a custom field the record already has a label for', () => {
    const record = existing();
    const withField: Credential = {
      ...record,
      fields: {
        ...record.fields,
        custom: [
          { id: 'a', label: 'Recovery', type: 'text', value: 'kept', hidden: false, order: 0 },
        ],
      },
    };

    const result = planMerge(
      withField,
      [
        incoming({
          custom: [
            { id: 'i1', label: 'recovery', type: 'text', value: 'stale', hidden: false, order: 0 },
          ],
        }),
      ],
      context
    );

    expect(result.fields.map((field) => field.field)).not.toContain('custom');
  });

  it('files a record that is filed nowhere, and never moves one that is', () => {
    const loose = planMerge(
      existing({ folderId: null }),
      [incoming({ folderId: importFolderId('Work') })],
      context
    );
    expect(loose.fields).toContainEqual({ field: 'folder', effect: 'fills-empty' });
    expect(loose.patch.folderId).toBe('folder-work');

    const filed = planMerge(
      { ...existing(), folderId: 'somewhere-the-user-chose' },
      [incoming({ folderId: importFolderId('Work') })],
      context
    );
    expect(filed.fields.map((field) => field.field)).not.toContain('folder');
    expect(filed.patch.folderId).toBeUndefined();
  });

  it('lets the later row win when several rows feed one record', () => {
    const result = planMerge(
      existing(),
      [incoming({ password: 'first' }), incoming({ password: '' }), incoming({ password: 'last' })],
      context
    );
    expect(result.patch.fields?.password).toBe('last');
  });

  it('describes the same change whether or not the ids can be resolved yet', () => {
    const record = existing({ email: '' });
    const rows = [incoming({ email: 'new@example.com', password: 'from-the-file' })];

    // The preview's context cannot mint an id or resolve a folder; the effects it produces
    // must still be the ones the commit will act on.
    expect(planMerge(record, rows, PREVIEW_MERGE_CONTEXT).fields).toEqual(
      planMerge(record, rows, context).fields
    );
  });

  it('produces an empty patch when nothing would change', () => {
    const result = planMerge(existing(), [incoming()], context);
    expect(result.fields).toEqual([]);
    expect(result.patch).toEqual({ fields: {} });
  });
});
