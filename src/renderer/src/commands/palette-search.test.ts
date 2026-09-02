// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  commandKey,
  credentialKey,
  itemDetail,
  itemTitle,
  matchReason,
  MAX_CREDENTIAL_RESULTS,
  searchPalette,
  type PaletteItem,
  type PaletteSearchInput,
} from './palette-search.js';
import { command, projection } from './test-fixtures.js';

const lock = command({ id: 'vault.lock', title: 'Lock the vault', keywords: ['close'] });
const gotoTrash = command({
  id: 'nav.trash',
  title: 'Go to Trash',
  section: 'Navigate',
  keywords: ['deleted'],
});

const github = projection({ id: 'r1', title: 'GitHub', username: 'octocat' });
const gitlab = projection({ id: 'r2', title: 'GitLab', username: 'fox' });
const bank = projection({ id: 'r3', title: 'Locksmith Bank', email: 'me@example.com' });

function input(overrides: Partial<PaletteSearchInput> = {}): PaletteSearchInput {
  return {
    commands: [lock, gotoTrash],
    credentials: [github, gitlab, bank],
    recentKeys: [],
    ...overrides,
  };
}

const keys = (items: readonly PaletteItem[]): readonly string[] => items.map((item) => item.key);

/**
 * The item at `index`, or a failure that says which lookup came up empty.
 *
 * `items[index]` is `PaletteItem | undefined` under `noUncheckedIndexedAccess`, and the
 * alternative — asserting the type away with `!` or `as` — would turn "the search returned
 * nothing" into a `TypeError` inside the function under test, several frames from the line
 * that actually failed.
 */
function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function itemAt(items: readonly PaletteItem[], index = 0): PaletteItem {
  return defined(items[index], `a palette item at index ${index}, got ${items.length} item(s)`);
}

describe('an empty query answers "what can I do?"', () => {
  it('lists commands and no credentials at all', () => {
    const { items } = searchPalette('', input());
    expect(items.every((item) => item.kind === 'command')).toBe(true);
    expect(items).toHaveLength(2);
  });

  it('puts recents first, in most-recent-first order', () => {
    const { items } = searchPalette('', input({ recentKeys: [commandKey('nav.trash')] }));
    expect(keys(items)).toEqual([commandKey('nav.trash'), commandKey('vault.lock')]);
  });

  it('drops a recent whose command is no longer available', () => {
    const { items } = searchPalette(
      '',
      input({ recentKeys: [commandKey('credential.duplicate'), credentialKey('r1')] })
    );
    expect(keys(items)).toEqual([commandKey('vault.lock'), commandKey('nav.trash')]);
  });

  it('never repeats a command that is also a recent', () => {
    const { items } = searchPalette('', input({ recentKeys: [commandKey('vault.lock')] }));
    expect(new Set(keys(items)).size).toBe(items.length);
  });
});

describe('a typed query searches both, on one scale', () => {
  it('finds credentials by title', () => {
    const { items } = searchPalette('github', input());
    expect(keys(items)).toEqual([credentialKey('r1')]);
  });

  it('finds commands and credentials together and ranks them against each other', () => {
    const { items } = searchPalette('lock', input());
    // "Lock the vault" is a prefix match on a command title; "Locksmith Bank" is a prefix
    // match on a record title. Same field, same kind, same score — so the tiebreak decides,
    // and the tiebreak puts the command first.
    expect(keys(items)).toEqual([commandKey('vault.lock'), credentialKey('r3')]);
  });

  it('puts a stronger credential match above a weaker command match', () => {
    const exactRecord = projection({ id: 'r9', title: 'Close' });
    const { items } = searchPalette(
      'close',
      input({ credentials: [exactRecord], commands: [lock] })
    );
    // The record's title is an exact match (title × exact); the command only matches on a
    // keyword (tag × exact). Field beats kind, so the record wins despite being a record.
    expect(keys(items)[0]).toBe(credentialKey('r9'));
  });

  it('ignores recents once something is typed', () => {
    const { items } = searchPalette(
      'github',
      input({ recentKeys: [commandKey('vault.lock'), credentialKey('r2')] })
    );
    expect(keys(items)).toEqual([credentialKey('r1')]);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchPalette('zzzzz', input()).items).toEqual([]);
  });
});

describe('the credential cap keeps the best matches, not the first ones', () => {
  /**
   * The bug this exists to prevent.
   *
   * `sortCredentials` defaults to **ascending**, and ascending relevance is worst-match
   * first. A cap applied to that order keeps exactly the records the user did not want, and
   * the symptom — "search finds my record only if I type the whole title" — looks like a
   * matching problem rather than a sorting one.
   */
  it('keeps the highest-scoring records when there are more than the cap', () => {
    const many = [
      // An exact title match, deliberately last in the input list.
      ...Array.from({ length: MAX_CREDENTIAL_RESULTS + 10 }, (_, index) =>
        projection({ id: `pad${index}`, title: `Contains acme somewhere ${index}` })
      ),
      projection({ id: 'best', title: 'acme' }),
    ];

    const { items } = searchPalette('acme', input({ commands: [], credentials: many }));

    expect(items).toHaveLength(MAX_CREDENTIAL_RESULTS);
    expect(items[0]?.key).toBe(credentialKey('best'));
    expect(keys(items)).toContain(credentialKey('best'));
  });

  it('does not cap commands', () => {
    const commands = Array.from({ length: 30 }, (_, index) =>
      command({ id: 'vault.lock', title: `Command acme ${index}` })
    );
    const { items } = searchPalette('acme', input({ commands, credentials: [] }));
    expect(items).toHaveLength(30);
  });
});

describe('the palette shows nothing secret', () => {
  /**
   * A structural assertion, not a spot check.
   *
   * The row renders `itemTitle` and `itemDetail` and nothing else. Both are asserted here
   * to come from named safe-projection fields, so adding a secret to a row means changing
   * one of these two functions — and failing this test.
   */
  it('renders a credential as its title and username only', () => {
    const item = itemAt(searchPalette('github', input()).items);
    expect(itemTitle(item)).toBe('GitHub');
    expect(itemDetail(item)).toBe('octocat');
  });

  it('falls back to the email when there is no username', () => {
    const item = searchPalette('locksmith', input()).items.find(
      (candidate) => candidate.kind === 'credential'
    );
    expect(itemDetail(defined(item, 'a credential row for "locksmith"'))).toBe('me@example.com');
  });

  it('exposes no field on a palette item beyond the projection and the score', () => {
    const item = itemAt(searchPalette('github', input()).items);
    expect(Object.keys(item).sort()).toEqual(['key', 'kind', 'matches', 'record', 'score']);
  });
});

describe('matchReason tells the user why a result is there', () => {
  it('names the field a credential matched on', () => {
    expect(matchReason(itemAt(searchPalette('octocat', input()).items))).toBe(
      'Matched on username'
    );
  });

  it('names a command surface in the command’s own vocabulary', () => {
    expect(matchReason(itemAt(searchPalette('lock the', input()).items))).toBe('Matched on name');
    expect(matchReason(itemAt(searchPalette('close', input({ credentials: [] })).items))).toBe(
      'Matched on keyword'
    );
  });

  it('is null when nothing was typed', () => {
    expect(matchReason(itemAt(searchPalette('', input()).items))).toBeNull();
  });

  /**
   * The honest label for a deep match.
   *
   * The main process matched something the renderer cannot see. Saying "Matched on title"
   * would be a lie about where the data is; saying nothing would make the row look random.
   */
  it('says the match was in a hidden field when the main process found it', () => {
    const secretive = projection({ id: 'deep', title: 'Nothing visible here' });
    const { items } = searchPalette(
      'zzzz',
      input({ commands: [], credentials: [secretive], deepMatches: ['deep'] })
    );
    expect(items).toHaveLength(1);
    expect(matchReason(itemAt(items))).toBe('Matched on hidden field');
  });
});
