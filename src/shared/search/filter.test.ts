// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { CredentialProjection } from '../model/credential.js';
import type { Folder, Tag } from '../model/vault-document.js';
import {
  collectDescendantFolderIds,
  filterCredentials,
  matchCredential,
  matchScore,
  scoresById,
  searchCredentials,
  type FilterOptions,
} from './filter.js';
import { parseQuery } from './query.js';

/**
 * What this file is really guarding:
 *
 *   1. trashed records staying out of the ordinary list
 *   2. a secret never being matchable, even if a malformed projection carries one
 *   3. a broken folder tree not hanging the UI thread
 *
 * The ranking and diacritic cases matter for whether search feels right; those three are
 * the ones where being wrong is a bug with consequences.
 */

const NOW = 1_700_000_000_000;

function projection(overrides: Partial<CredentialProjection> = {}): CredentialProjection {
  return {
    id: 'c1',
    type: 'login',
    title: 'Untitled',
    favorite: false,
    folderId: null,
    tags: [],
    icon: { kind: 'auto' },
    username: '',
    email: '',
    urls: [],
    hasPassword: true,
    passwordLength: 16,
    hasNotes: false,
    notesLength: 0,
    securityQuestions: [],
    custom: [],
    attachments: [],
    meta: {
      createdAt: NOW,
      updatedAt: NOW,
      passwordUpdatedAt: NOW,
      lastUsedAt: null,
      useCount: 0,
      expiresAt: null,
      rotationIntervalDays: null,
      createdOrigin: { action: 'create' },
    },
    historyEnabled: true,
    historyCount: 0,
    history: [],
    trashedAt: null,
    ...overrides,
  };
}

const ids = (records: readonly CredentialProjection[]): readonly string[] =>
  records.map((record) => record.id);

const find = (
  records: readonly CredentialProjection[],
  text: string,
  options: FilterOptions = {}
) => filterCredentials(records, { ...options, query: parseQuery(text) });

describe('filterCredentials — the trash', () => {
  const live = projection({ id: 'live' });
  const gone = projection({ id: 'gone', trashedAt: NOW });
  const records = [live, gone];

  it('excludes trashed records by default', () => {
    expect(ids(filterCredentials(records))).toEqual(['live']);
  });

  it('includes them only when asked', () => {
    expect(ids(filterCredentials(records, { includeTrashed: true }))).toEqual(['live', 'gone']);
  });

  it('shows only trashed records in the trash view', () => {
    expect(ids(filterCredentials(records, { trashedOnly: true }))).toEqual(['gone']);
  });

  it('treats an explicit is:trashed as asking for them', () => {
    expect(ids(find(records, 'is:trashed'))).toEqual(['gone']);
  });

  it('still excludes them under -is:trashed', () => {
    expect(ids(find(records, '-is:trashed'))).toEqual(['live']);
  });

  it('keeps them out of an ordinary text search that would otherwise match', () => {
    const trashedMatch = projection({ id: 'gone2', title: 'GitHub', trashedAt: NOW });
    expect(
      ids(find([projection({ id: 'live2', title: 'GitHub' }), trashedMatch], 'github'))
    ).toEqual(['live2']);
  });
});

describe('filterCredentials — structured filters', () => {
  const folders: readonly Folder[] = [
    { id: 'root', name: 'Work', parentId: null, order: 0 },
    { id: 'child', name: 'Servers', parentId: 'root', order: 0 },
    { id: 'grandchild', name: 'Staging', parentId: 'child', order: 0 },
    { id: 'other', name: 'Personal', parentId: null, order: 1 },
  ];
  const records = [
    projection({ id: 'inRoot', folderId: 'root' }),
    projection({ id: 'inChild', folderId: 'child' }),
    projection({ id: 'inGrandchild', folderId: 'grandchild' }),
    projection({ id: 'inOther', folderId: 'other' }),
    projection({ id: 'unfiled', folderId: null }),
  ];

  it('matches one folder exactly by default', () => {
    expect(ids(filterCredentials(records, { folderId: 'root', folders }))).toEqual(['inRoot']);
  });

  it('includes descendants when asked', () => {
    expect(
      ids(filterCredentials(records, { folderId: 'root', folders, includeDescendantFolders: true }))
    ).toEqual(['inRoot', 'inChild', 'inGrandchild']);
  });

  it('treats folderId: null as the unfiled view', () => {
    expect(ids(filterCredentials(records, { folderId: null }))).toEqual(['unfiled']);
  });

  it('filters by tag, any by default and all on request', () => {
    const tagged = [
      projection({ id: 'both', tags: ['t1', 't2'] }),
      projection({ id: 'one', tags: ['t1'] }),
      projection({ id: 'none', tags: [] }),
    ];
    expect(ids(filterCredentials(tagged, { tagIds: ['t1', 't2'] }))).toEqual(['both', 'one']);
    expect(ids(filterCredentials(tagged, { tagIds: ['t1', 't2'], tagMatch: 'all' }))).toEqual([
      'both',
    ]);
  });

  it('filters by favourite', () => {
    const records2 = [projection({ id: 'star', favorite: true }), projection({ id: 'plain' })];
    expect(ids(filterCredentials(records2, { favouritesOnly: true }))).toEqual(['star']);
    expect(ids(find(records2, 'is:favorite'))).toEqual(['star']);
  });
});

describe('collectDescendantFolderIds', () => {
  it('walks the whole subtree', () => {
    const folders: readonly Folder[] = [
      { id: 'a', name: 'a', parentId: null, order: 0 },
      { id: 'b', name: 'b', parentId: 'a', order: 0 },
      { id: 'c', name: 'c', parentId: 'b', order: 0 },
      { id: 'd', name: 'd', parentId: null, order: 1 },
    ];
    expect([...collectDescendantFolderIds(folders, 'a')].sort()).toEqual(['a', 'b', 'c']);
  });

  it('terminates on a cycle instead of hanging the UI thread', () => {
    // A merged or hand-edited vault can contain this. It must render badly, not freeze.
    const cyclic: readonly Folder[] = [
      { id: 'a', name: 'a', parentId: 'b', order: 0 },
      { id: 'b', name: 'b', parentId: 'a', order: 0 },
      { id: 'c', name: 'c', parentId: 'b', order: 0 },
    ];
    expect([...collectDescendantFolderIds(cyclic, 'a')].sort()).toEqual(['a', 'b', 'c']);
  });

  it('survives a folder that is its own parent', () => {
    const selfParented: readonly Folder[] = [{ id: 'a', name: 'a', parentId: 'a', order: 0 }];
    expect([...collectDescendantFolderIds(selfParented, 'a')]).toEqual(['a']);
  });

  it('filters cyclic folders without hanging', () => {
    const cyclic: readonly Folder[] = [
      { id: 'a', name: 'a', parentId: 'b', order: 0 },
      { id: 'b', name: 'b', parentId: 'a', order: 0 },
    ];
    const records = [projection({ id: 'x', folderId: 'b' }), projection({ id: 'y' })];
    expect(
      ids(
        filterCredentials(records, {
          folderId: 'a',
          folders: cyclic,
          includeDescendantFolders: true,
        })
      )
    ).toEqual(['x']);
  });
});

describe('searchCredentials — matching', () => {
  const github = projection({
    id: 'github',
    title: 'GitHub',
    username: 'anahat',
    email: 'anahat@example.com',
    urls: ['https://github.com'],
    tags: ['tag-dev'],
    folderId: 'folder-work',
  });
  const bank = projection({
    id: 'bank',
    title: 'Café Bank',
    username: 'am',
    urls: ['https://bank.example'],
  });
  const records = [github, bank];
  const context = {
    folders: [{ id: 'folder-work', name: 'Work', parentId: null, order: 0 }] as readonly Folder[],
    tags: [{ id: 'tag-dev', name: 'Development', colour: 'accent' }] as readonly Tag[],
  };

  it('matches across every searchable surface for a bare term', () => {
    expect(ids(find(records, 'anahat'))).toEqual(['github']);
    expect(ids(find(records, 'example.com'))).toEqual(['github']);
    expect(ids(find(records, 'development', context))).toEqual(['github']);
    expect(ids(find(records, 'work', context))).toEqual(['github']);
  });

  it('ignores case and diacritics in both directions', () => {
    expect(ids(find(records, 'cafe'))).toEqual(['bank']);
    expect(ids(find(records, 'CAFÉ'))).toEqual(['bank']);
    expect(ids(find([projection({ id: 'plain', title: 'Cafe Bank' })], 'café'))).toEqual(['plain']);
  });

  it('ANDs terms, and lets each one match a different field', () => {
    expect(ids(find(records, 'github anahat'))).toEqual(['github']);
    expect(ids(find(records, 'github nonsense'))).toEqual([]);
  });

  it('honours a scoped term', () => {
    expect(ids(find(records, 'title:github'))).toEqual(['github']);
    expect(ids(find(records, 'title:anahat'))).toEqual([]);
    expect(ids(find(records, 'user:anahat'))).toEqual(['github']);
    expect(ids(find(records, 'url:bank.example'))).toEqual(['bank']);
    expect(ids(find(records, 'tag:development', context))).toEqual(['github']);
    expect(ids(find(records, 'folder:work', context))).toEqual(['github']);
  });

  it('falls back to the raw id when no name is supplied for a tag or folder', () => {
    expect(ids(find(records, 'tag:tag-dev'))).toEqual(['github']);
  });

  it('excludes on a negated term', () => {
    expect(ids(find(records, '-github'))).toEqual(['bank']);
    expect(ids(find(records, '-title:github'))).toEqual(['bank']);
  });

  it('matches a quoted phrase contiguously', () => {
    expect(ids(find(records, '"café bank"'))).toEqual(['bank']);
    expect(ids(find(records, '"bank café"'))).toEqual([]);
  });

  it('matches a security question prompt but has no answer to match', () => {
    const withQuestion = projection({
      id: 'q',
      securityQuestions: [{ id: 'q1', question: "Your first pet's name?", hasAnswer: true }],
    });
    expect(ids(find([withQuestion], 'first pet'))).toEqual(['q']);
  });

  it('returns everything for an empty query, minus the trash', () => {
    expect(ids(find(records, '   '))).toEqual(['github', 'bank']);
  });
});

describe('searchCredentials — the secret boundary', () => {
  /**
   * A projection that should not exist: a field marked secret that still carries a value.
   * If the matcher read `value` before checking `isSecret`, search would become an oracle
   * for password contents, one keystroke at a time.
   */
  const malformed = projection({
    id: 'malformed',
    title: 'Bank',
    custom: [
      {
        id: 'f1',
        label: 'Recovery code',
        type: 'password',
        hidden: true,
        order: 0,
        value: 'hunter2',
        hasValue: true,
        isSecret: true,
      },
    ],
  });

  it('never matches the value of a field marked secret', () => {
    expect(ids(find([malformed], 'hunter2'))).toEqual([]);
    expect(ids(find([malformed], 'hunter'))).toEqual([]);
    expect(ids(find([malformed], 'field:hunter2'))).toEqual([]);
  });

  it('never puts a secret value into the returned match information', () => {
    // Searched *for* the leaked value on purpose. Phrased against a query that only the
    // secret could satisfy, so the assertion is not quietly satisfied by a title match
    // outranking the leak — an earlier version of this test was, and passed while the
    // secret gate was removed.
    for (const query of ['hunter2', 'bank hunter2', 'field:hunter2']) {
      const results = searchCredentials([malformed], { query: parseQuery(query) });
      expect(results, query).toHaveLength(0);
      expect(JSON.stringify(results), query).not.toContain('hunter2');
    }
  });

  it('still matches the label of a secret field, which is not secret', () => {
    expect(ids(find([malformed], 'field:recovery'))).toEqual(['malformed']);
    expect(ids(find([malformed], '"recovery code"'))).toEqual(['malformed']);
    // Two bare terms may both land on the same field — but each still has to land.
    expect(ids(find([malformed], 'recovery code'))).toEqual(['malformed']);
    expect(ids(find([malformed], 'recovery hunter2'))).toEqual([]);
  });

  it('matches the value of a non-secret custom field', () => {
    const visible = projection({
      id: 'visible',
      custom: [
        {
          id: 'f1',
          label: 'Account number',
          type: 'text',
          hidden: false,
          order: 0,
          value: '4471',
          hasValue: true,
          isSecret: false,
        },
      ],
    });
    expect(ids(find([visible], '4471'))).toEqual(['visible']);
    expect(ids(find([visible], 'field:4471'))).toEqual([]); // field: is the label, not the value
  });
});

describe('searchCredentials — flags', () => {
  it('derives every flag from the projection alone', () => {
    const rich = projection({
      id: 'rich',
      favorite: true,
      tags: ['t1'],
      folderId: 'f1',
      hasPassword: true,
      hasNotes: true,
      attachments: [
        {
          id: 'a'.repeat(32),
          name: 'k.pdf',
          mime: 'application/pdf',
          size: 1,
          sha256: '',
          addedAt: NOW,
        },
      ],
      custom: [
        {
          id: 'f1',
          label: 'TOTP',
          type: 'otp-secret',
          hidden: false,
          order: 0,
          hasValue: true,
          isSecret: true,
        },
      ],
      urls: ['https://example.com'],
      historyCount: 3,
    });
    const bare = projection({ id: 'bare', hasPassword: false });
    const records = [rich, bare];

    for (const flag of [
      'is:favorite',
      'has:password',
      'has:notes',
      'has:attachment',
      'has:totp',
      'has:url',
      'has:history',
    ]) {
      expect(ids(find(records, flag)), flag).toEqual(['rich']);
      expect(ids(find(records, `-${flag}`)), flag).toEqual(['bare']);
    }
    expect(ids(find(records, 'is:untagged'))).toEqual(['bare']);
    expect(ids(find(records, 'is:unfiled'))).toEqual(['bare']);
  });

  it('ANDs flags with terms', () => {
    const records = [
      projection({ id: 'a', title: 'Bank', favorite: true }),
      projection({ id: 'b', title: 'Bank' }),
    ];
    expect(ids(find(records, 'bank is:favorite'))).toEqual(['a']);
  });
});

describe('searchCredentials — ranking', () => {
  it('ranks a title match above a URL match', () => {
    const byTitle = projection({ id: 'byTitle', title: 'GitHub' });
    const byUrl = projection({ id: 'byUrl', title: 'Work account', urls: ['https://github.com'] });
    const results = searchCredentials([byUrl, byTitle], { query: parseQuery('github') });
    const scores = scoresById(results);
    expect(scores.get('byTitle')).toBeGreaterThan(scores.get('byUrl') ?? 0);
  });

  it('ranks exact above prefix above substring within a field', () => {
    const exact = projection({ id: 'exact', title: 'Bank' });
    const prefix = projection({ id: 'prefix', title: 'Bank of America' });
    const substring = projection({ id: 'substring', title: 'My bank' });
    const results = searchCredentials([substring, prefix, exact], { query: parseQuery('bank') });
    const scores = scoresById(results);
    expect(scores.get('exact')).toBeGreaterThan(scores.get('prefix') ?? 0);
    expect(scores.get('prefix')).toBeGreaterThan(scores.get('substring') ?? 0);
  });

  it('lets the field dominate the kind, so a title substring beats a URL exact match', () => {
    expect(matchScore('title', 'substring')).toBeGreaterThan(matchScore('url', 'exact'));
  });

  it('reports where each term matched, in term order', () => {
    const record = projection({
      id: 'r',
      title: 'GitHub',
      username: 'anahat',
      urls: ['https://github.com'],
    });
    const result = matchCredential(record, parseQuery('github anahat'));
    expect(result?.matches.map((match) => [match.field, match.kind, match.termIndex])).toEqual([
      ['title', 'exact', 0],
      ['username', 'exact', 1],
    ]);
  });

  it('sums the terms, so matching twice outranks matching once', () => {
    const both = projection({ id: 'both', title: 'GitHub', username: 'github' });
    const one = projection({ id: 'one', title: 'GitHub', username: 'anahat' });
    const scores = scoresById(searchCredentials([one, both], { query: parseQuery('github') }));
    expect(scores.get('both')).toBe(scores.get('one'));

    const two = scoresById(searchCredentials([one, both], { query: parseQuery('github github') }));
    expect(two.get('both')).toBeGreaterThan(0);
  });
});

describe('searchCredentials — deep matches from the main process', () => {
  const record = projection({ id: 'deep', title: 'Bank' });

  it('lets a main-process id satisfy a term the projection cannot', () => {
    expect(ids(filterCredentials([record], { query: parseQuery('recovery') }))).toEqual([]);
    expect(
      ids(
        filterCredentials([record], {
          query: parseQuery('recovery'),
          deepMatchIds: new Set(['deep']),
        })
      )
    ).toEqual(['deep']);
  });

  it('ranks a deep match below every visible one', () => {
    const visible = projection({ id: 'visible', title: 'recovery' });
    const results = searchCredentials([record, visible], {
      query: parseQuery('recovery'),
      deepMatchIds: new Set(['deep']),
    });
    const scores = scoresById(results);
    expect(scores.get('visible')).toBeGreaterThan(scores.get('deep') ?? 0);
  });

  it('never lets a deep match satisfy a negated term', () => {
    // The main process reports what it found, never what is absent — so exclusion stays
    // a question about the safe projection only.
    expect(
      ids(
        filterCredentials([record], {
          query: parseQuery('-recovery'),
          deepMatchIds: new Set(['deep']),
        })
      )
    ).toEqual(['deep']);
  });
});
