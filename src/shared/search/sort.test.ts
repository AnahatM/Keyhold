// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { CredentialProjection } from '../model/credential.js';
import {
  compareCredentials,
  DEFAULT_SORT_DIRECTION,
  SORT_KEYS,
  sortCredentials,
  TITLE_COLLATOR,
  type SortDirection,
  type SortKey,
} from './sort.js';

/**
 * Two properties are worth more than all the individual orderings below: the comparator is
 * **total** (0 only for the same record) and the sort is therefore **stable** whatever the
 * engine does. A list that quietly reorders itself between renders is one of those bugs
 * nobody can reproduce on demand, so it is asserted directly, over every key.
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

const titles = (records: readonly CredentialProjection[]): readonly string[] =>
  records.map((record) => record.title);
const ids = (records: readonly CredentialProjection[]): readonly string[] =>
  records.map((record) => record.id);

/**
 * A deterministic shuffle. `Math.random()` is banned project-wide and would make a failure
 * here unreproducible anyway — the whole point is that the output does not depend on the
 * input order, so the input order has to be something we can print in a bug report.
 */
function shuffled<T>(items: readonly T[], seed: number): readonly T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = state % (i + 1);
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

describe('sortCredentials — titles', () => {
  it('sorts "Item 10" after "Item 9"', () => {
    const records = [
      projection({ id: 'a', title: 'Item 10' }),
      projection({ id: 'b', title: 'Item 9' }),
      projection({ id: 'c', title: 'Item 1' }),
    ];
    expect(titles(sortCredentials(records, { key: 'title' }))).toEqual([
      'Item 1',
      'Item 9',
      'Item 10',
    ]);
  });

  it('does not group by case', () => {
    const records = [
      projection({ id: 'a', title: 'banana' }),
      projection({ id: 'b', title: 'Apple' }),
      projection({ id: 'c', title: 'cherry' }),
    ];
    expect(titles(sortCredentials(records, { key: 'title' }))).toEqual([
      'Apple',
      'banana',
      'cherry',
    ]);
  });

  it('ignores accents for ordering, as the collator is configured to', () => {
    expect(TITLE_COLLATOR.compare('Café', 'cafe')).toBe(0);
    const records = [
      projection({ id: 'b', title: 'Cafe' }),
      projection({ id: 'a', title: 'Café' }),
    ];
    // Equal under the collator, so the id tiebreak decides — deterministically.
    expect(ids(sortCredentials(records, { key: 'title' }))).toEqual(['a', 'b']);
  });

  it('reverses on descending but keeps the id tiebreak ascending', () => {
    const records = [
      projection({ id: 'z', title: 'same' }),
      projection({ id: 'a', title: 'same' }),
      projection({ id: 'm', title: 'other' }),
    ];
    expect(ids(sortCredentials(records, { key: 'title', direction: 'asc' }))).toEqual([
      'm',
      'a',
      'z',
    ]);
    expect(ids(sortCredentials(records, { key: 'title', direction: 'desc' }))).toEqual([
      'a',
      'z',
      'm',
    ]);
  });
});

describe('sortCredentials — lastUsedAt nulls', () => {
  const never = projection({ id: 'never' });
  const old = projection({ id: 'old', meta: { ...never.meta, lastUsedAt: NOW - 1000 } });
  const recent = projection({ id: 'recent', meta: { ...never.meta, lastUsedAt: NOW } });
  const records = [never, recent, old];

  it('puts never-used records last when ascending', () => {
    expect(ids(sortCredentials(records, { key: 'lastUsedAt', direction: 'asc' }))).toEqual([
      'old',
      'recent',
      'never',
    ]);
  });

  it('puts never-used records last when descending too', () => {
    // The important half: descending is the "recently used" view, and a never-used record
    // at the top of it would read as a bug.
    expect(ids(sortCredentials(records, { key: 'lastUsedAt', direction: 'desc' }))).toEqual([
      'recent',
      'old',
      'never',
    ]);
  });

  it('orders several never-used records by id rather than arbitrarily', () => {
    const many = [projection({ id: 'c' }), projection({ id: 'a' }), projection({ id: 'b' })];
    for (const direction of ['asc', 'desc'] as const) {
      expect(ids(sortCredentials(many, { key: 'lastUsedAt', direction }))).toEqual(['a', 'b', 'c']);
    }
  });
});

describe('sortCredentials — the other keys', () => {
  const base = projection().meta;
  const records = [
    projection({
      id: 'a',
      title: 'A',
      username: 'zoe',
      meta: { ...base, createdAt: 3, updatedAt: 1, passwordUpdatedAt: 2, useCount: 7 },
    }),
    projection({
      id: 'b',
      title: 'B',
      username: 'adam',
      meta: { ...base, createdAt: 1, updatedAt: 3, passwordUpdatedAt: 1, useCount: 2 },
    }),
    projection({
      id: 'c',
      title: 'C',
      username: 'mia',
      meta: { ...base, createdAt: 2, updatedAt: 2, passwordUpdatedAt: 3, useCount: 9 },
    }),
  ];

  it('sorts each numeric key ascending', () => {
    expect(ids(sortCredentials(records, { key: 'createdAt' }))).toEqual(['b', 'c', 'a']);
    expect(ids(sortCredentials(records, { key: 'updatedAt' }))).toEqual(['a', 'c', 'b']);
    expect(ids(sortCredentials(records, { key: 'passwordUpdatedAt' }))).toEqual(['b', 'a', 'c']);
    expect(ids(sortCredentials(records, { key: 'useCount' }))).toEqual(['b', 'a', 'c']);
  });

  it('sorts usernames with the same collator', () => {
    expect(ids(sortCredentials(records, { key: 'username' }))).toEqual(['b', 'c', 'a']);
  });

  it('sorts by relevance from a supplied score map, best first when descending', () => {
    const scores = new Map([
      ['a', 5],
      ['b', 50],
      ['c', 12],
    ]);
    expect(ids(sortCredentials(records, { key: 'relevance', direction: 'desc', scores }))).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(ids(sortCredentials(records, { key: 'relevance', direction: 'asc', scores }))).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('treats a record missing from the score map as unscored, not as an error', () => {
    const scores = new Map([['a', 5]]);
    expect(ids(sortCredentials(records, { key: 'relevance', direction: 'desc', scores }))).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(ids(sortCredentials(records, { key: 'relevance', direction: 'desc' }))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('names a sensible default direction for every key', () => {
    for (const key of SORT_KEYS) {
      expect(DEFAULT_SORT_DIRECTION[key], key).toMatch(/^(asc|desc)$/);
    }
  });
});

describe('sortCredentials — totality and stability', () => {
  /** Deliberately full of ties: same title bar case, same dates, same counts, null dates. */
  const records: readonly CredentialProjection[] = [
    projection({ id: 'id-1', title: 'Same', username: 'u' }),
    projection({ id: 'id-2', title: 'same', username: 'U' }),
    projection({ id: 'id-3', title: 'SAME', username: 'u' }),
    projection({ id: 'id-4', title: 'Other', username: 'u' }),
    projection({
      id: 'id-5',
      title: 'Same',
      username: 'u',
      meta: { ...projection().meta, lastUsedAt: NOW },
    }),
  ];

  it('returns 0 only for the same record, on every key and direction', () => {
    for (const key of SORT_KEYS) {
      for (const direction of ['asc', 'desc'] as SortDirection[]) {
        for (const a of records) {
          for (const b of records) {
            const result = compareCredentials(a, b, { key, direction });
            if (a.id === b.id) {
              expect(result, `${key}/${direction}/${a.id}`).toBe(0);
            } else {
              expect(result, `${key}/${direction}/${a.id}/${b.id}`).not.toBe(0);
              // Antisymmetric, or the sort's result depends on the comparison order.
              expect(
                Math.sign(result) + Math.sign(compareCredentials(b, a, { key, direction })),
                `${key}/${direction}/${a.id}/${b.id}`
              ).toBe(0);
            }
          }
        }
      }
    }
  });

  it('produces the same order whatever order it is given, on every key', () => {
    for (const key of SORT_KEYS) {
      for (const direction of ['asc', 'desc'] as SortDirection[]) {
        const options = { key, direction };
        const expected = ids(sortCredentials(records, options));
        for (const seed of [1, 7, 99, 1234, 65_537]) {
          expect(ids(sortCredentials(shuffled(records, seed), options)), `${key}/${seed}`).toEqual(
            expected
          );
        }
      }
    }
  });

  it('does not mutate the input', () => {
    const input = [...records];
    const before = ids(input);
    sortCredentials(input, { key: 'title' });
    expect(ids(input)).toEqual(before);
  });

  it('actually reads the field each key names', () => {
    /**
     * One pair per key, differing *only* on that key — and with ids deliberately ordered
     * the other way round ("higher" sorts before "lower" by id). So a key that reads the
     * wrong field, or is not implemented at all, falls through to the id tiebreak and
     * comes back reversed. Keyed by `SortKey`, so a new key cannot skip this.
     */
    const meta = projection().meta;
    const pairs: Readonly<Record<SortKey, readonly [CredentialProjection, CredentialProjection]>> =
      {
        title: [
          projection({ id: 'lower', title: 'aaa' }),
          projection({ id: 'higher', title: 'bbb' }),
        ],
        username: [
          projection({ id: 'lower', username: 'aaa' }),
          projection({ id: 'higher', username: 'bbb' }),
        ],
        createdAt: [
          projection({ id: 'lower', meta: { ...meta, createdAt: 1 } }),
          projection({ id: 'higher', meta: { ...meta, createdAt: 2 } }),
        ],
        updatedAt: [
          projection({ id: 'lower', meta: { ...meta, updatedAt: 1 } }),
          projection({ id: 'higher', meta: { ...meta, updatedAt: 2 } }),
        ],
        passwordUpdatedAt: [
          projection({ id: 'lower', meta: { ...meta, passwordUpdatedAt: 1 } }),
          projection({ id: 'higher', meta: { ...meta, passwordUpdatedAt: 2 } }),
        ],
        lastUsedAt: [
          projection({ id: 'lower', meta: { ...meta, lastUsedAt: 1 } }),
          projection({ id: 'higher', meta: { ...meta, lastUsedAt: 2 } }),
        ],
        useCount: [
          projection({ id: 'lower', meta: { ...meta, useCount: 1 } }),
          projection({ id: 'higher', meta: { ...meta, useCount: 2 } }),
        ],
        relevance: [projection({ id: 'lower' }), projection({ id: 'higher' })],
      };
    const scores = new Map([
      ['lower', 1],
      ['higher', 2],
    ]);

    for (const key of SORT_KEYS) {
      const [lower, higher] = pairs[key];
      expect(ids(sortCredentials([higher, lower], { key, direction: 'asc', scores })), key).toEqual(
        ['lower', 'higher']
      );
    }
  });
});
