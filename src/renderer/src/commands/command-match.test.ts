// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { matchScore, parseQuery } from '@shared/search/index.js';
import { COMMAND_FIELDS, commandSurfaces, matchCommand, searchCommands } from './command-match.js';
import { command } from './test-fixtures.js';

/**
 * Command matching, and the guard that keeps it on the same rules as credential matching.
 */

const lock = command({ id: 'vault.lock', title: 'Lock the vault', keywords: ['close', 'secure'] });
const trash = command({
  id: 'credential.trash',
  title: 'Move the selected record to Trash',
  section: 'Record',
  keywords: ['delete', 'remove'],
});
const all = [lock, trash];

const run = (text: string) => searchCommands(all, parseQuery(text));

/**
 * There is no `classifyMatch` drift guard here any more, deliberately.
 *
 * This file used to mirror the engine's three-line `classifyMatch` and pin the copy against
 * `searchCredentials`' observable output, because `@shared/search/filter.ts` did not export
 * it. It does now, `command-match.ts` imports it, and a test comparing the engine's function
 * to the engine's own search results could no longer fail. The contract it was guarding is
 * asserted directly in `src/shared/search/filter.test.ts`, next to the function.
 */
describe('commandSurfaces stays inside the declared mapping', () => {
  /**
   * `COMMAND_FIELDS` is the list; this is the assertion that makes it mean something.
   *
   * A surface built on a field outside the three would be scored by `matchScore` against a
   * weight chosen for credential records — `url`, say, which outranks a tag — and a command
   * would start outranking real credentials for no reason a reader of this file could see.
   */
  it('emits no field the mapping does not declare', () => {
    const declared: readonly string[] = COMMAND_FIELDS;
    for (const surface of commandSurfaces(trash)) {
      expect(declared, surface.text).toContain(surface.field);
    }
  });

  it('covers all three: a title, a section and one surface per keyword', () => {
    const fields = commandSurfaces(trash).map((surface) => surface.field);
    expect(fields).toEqual(['title', 'folder', 'tag', 'tag']);
  });
});

describe('matchCommand', () => {
  it('returns every command for an empty query', () => {
    expect(run('')).toHaveLength(2);
    expect(run('   ')).toHaveLength(2);
  });

  it('matches on the title', () => {
    const hits = run('lock');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.command.definition.id).toBe('vault.lock');
    expect(hits[0]?.matches[0]?.field).toBe('title');
  });

  it('matches on a keyword the title does not contain', () => {
    const hits = run('delete');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.command.definition.id).toBe('credential.trash');
    expect(hits[0]?.matches[0]?.field).toBe('tag');
  });

  it('matches on the section', () => {
    const hits = run('record');
    expect(hits.map((hit) => hit.command.definition.id)).toContain('credential.trash');
  });

  it('folds case and diacritics exactly as the engine does', () => {
    expect(run('LOCK')).toHaveLength(1);
    expect(run('lóck')).toHaveLength(1);
  });

  it('ANDs multiple terms', () => {
    expect(run('lock vault')).toHaveLength(1);
    expect(run('lock trash')).toHaveLength(0);
  });

  it('honours negation', () => {
    const hits = run('-lock');
    expect(hits.map((hit) => hit.command.definition.id)).toEqual(['credential.trash']);
  });

  it('scores a title match above a keyword match, on the engine’s own scale', () => {
    const titleHit = matchCommand(lock, parseQuery('lock'));
    const keywordHit = matchCommand(lock, parseQuery('secure'));
    expect(titleHit?.score).toBe(matchScore('title', 'prefix'));
    expect(keywordHit?.score).toBe(matchScore('tag', 'exact'));
    expect(titleHit?.score).toBeGreaterThan(keywordHit?.score ?? 0);
  });

  it('scores an exact title above a substring title', () => {
    const exact = matchCommand(command({ title: 'Lock' }), parseQuery('lock'));
    const substring = matchCommand(command({ title: 'Really lock it' }), parseQuery('lock'));
    expect(exact?.score).toBeGreaterThan(substring?.score ?? 0);
  });
});

describe('record-shaped queries do not return commands', () => {
  /**
   * `is:untagged` is true of every menu item and false of every menu item, depending on how
   * you squint. The honest answer is that the question is not about commands at all.
   */
  it('drops every command when the query carries a flag', () => {
    expect(run('is:favorite')).toHaveLength(0);
    expect(run('has:totp')).toHaveLength(0);
    expect(run('lock is:untagged')).toHaveLength(0);
  });

  it('drops every command for a field-scoped term that is not title:', () => {
    expect(run('url:github')).toHaveLength(0);
    expect(run('user:alice')).toHaveLength(0);
    expect(run('tag:work')).toHaveLength(0);
  });

  it('honours title: as a scoped term', () => {
    expect(run('title:lock')).toHaveLength(1);
    // The keyword is not in the title, so a title-scoped search must not find it.
    expect(run('title:secure')).toHaveLength(0);
  });

  it('ignores a negated record-scoped term rather than dropping everything', () => {
    // `-url:github` is trivially true of a command, so it narrows nothing.
    expect(run('lock -url:github')).toHaveLength(1);
  });
});
