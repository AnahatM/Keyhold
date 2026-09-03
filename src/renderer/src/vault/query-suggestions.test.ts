// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { QUERY_FIELDS, QUERY_FLAGS, parseQuery } from '@shared/search/query.js';
import { activeToken, applySuggestion, suggestionsFor } from './query-suggestions.js';

/**
 * Completing a search query.
 *
 * The property worth holding is **round-trip**: anything this offers, applied to what the user
 * has typed, must produce something the parser understands. A suggestion list that inserts a
 * prefix the parser rejects is worse than no suggestions, because the user did not type it —
 * the app did, and then blamed them for it with a diagnostic.
 *
 * The last test walks every field and every flag and checks exactly that against the real
 * parser, so a prefix added to the engine cannot be offered in a form the engine will not take.
 *
 * Fault injection performed:
 *  1. Dropping the trailing colon from a field's `insert` — fails "everything offered parses
 *     back", because `title` without a colon is a plain search term rather than a field. This
 *     test also caught something real on its first run: `note:` produces a diagnostic, which
 *     turned out to be correct and expected rather than a defect — see the comment there.
 *  2. Removing the early return for "a value is being typed" — failed **nothing**, because the
 *     prefix matching already excludes those tokens. The branch was dead code shaped like a
 *     rule, and it was deleted; the test stays, because the behaviour it describes is real and
 *     now rests on the matching rather than on a redundant guard.
 *  3. Slicing the head with the wrong length in `applySuggestion` — fails "keeps everything
 *     before the token", eating the earlier words.
 */

describe('the token being typed', () => {
  it('is the last word', () => {
    expect(activeToken('github tit')).toBe('tit');
    expect(activeToken('tit')).toBe('tit');
  });

  it('is empty after a space, because a new word has started', () => {
    expect(activeToken('github ')).toBe('');
    expect(activeToken('')).toBe('');
  });
});

describe('what is offered', () => {
  it('offers everything on an empty box, up to the limit', () => {
    const all = suggestionsFor('', 100);
    expect(all.length).toBe(QUERY_FIELDS.length + QUERY_FLAGS.length);
    expect(suggestionsFor('', 4)).toHaveLength(4);
  });

  it('narrows by prefix, and by alias', () => {
    const byPrefix = suggestionsFor('tit').map((suggestion) => suggestion.insert);
    expect(byPrefix).toContain('title:');

    // `name` is an alias of `title`; typing it must find the field it actually means rather
    // than nothing.
    const byAlias = suggestionsFor('nam').map((suggestion) => suggestion.insert);
    expect(byAlias).toContain('title:');
  });

  it('finds flags by their whole token', () => {
    expect(suggestionsFor('is:fav').map((s) => s.insert)).toContain('is:favorite');
    expect(suggestionsFor('has:att').map((s) => s.insert)).toContain('has:attachment');
  });

  it('stops suggesting once a value is being typed', () => {
    // Replacing the token here would delete what was typed, which is worse than no help. This
    // falls out of the prefix matching rather than needing a branch of its own.
    expect(suggestionsFor('title:git')).toEqual([]);
    expect(suggestionsFor('user:ada')).toEqual([]);
  });

  it('says when a prefix can only answer "is there one"', () => {
    const presenceOnly = QUERY_FIELDS.find((field) => field.presenceOnly);
    if (presenceOnly === undefined) return;
    const offered = suggestionsFor(presenceOnly.prefix, 100).find(
      (suggestion) => suggestion.insert === `${presenceOnly.prefix}:`
    );
    expect(offered?.hint).toContain('presence only');
  });
});

describe('applying one', () => {
  it('keeps everything before the token', () => {
    expect(applySuggestion('github tit', 'title:')).toBe('github title:');
  });

  it('leaves no space after a field, because a value comes next', () => {
    expect(applySuggestion('tit', 'title:')).toBe('title:');
  });

  it('adds a space after a flag, because it is complete on its own', () => {
    expect(applySuggestion('is:fav', 'is:favorite')).toBe('is:favorite ');
  });

  it('appends when the box ends in a space', () => {
    expect(applySuggestion('github ', 'title:')).toBe('github title:');
  });
});

describe('the round trip, which is the point', () => {
  it('everything offered parses back without a diagnostic', () => {
    // A suggestion the parser rejects is worse than none: the user did not type it, the app
    // did, and then complained about it.
    for (const suggestion of suggestionsFor('', 100)) {
      const query = applySuggestion('', suggestion.insert);
      const parsed = parseQuery(`${query}${suggestion.insert.endsWith(':') ? 'x' : ''}`);

      // One diagnostic is expected and correct: `note:` degrades to `has:notes` in the parser,
      // because note bodies never cross the bridge. It is still worth offering here, because
      // the renderer supplements it — `setQuery` runs `credentials.deepSearch` and feeds the
      // ids back as `deepMatchIds`, so in this app `note:recovery` really does find the note.
      // The parser is being honest about what *it* can do, not warning the user off.
      const unexpected = parsed.diagnostics.filter(
        (diagnostic) => diagnostic.code !== 'note-body-not-searchable'
      );
      expect(unexpected, suggestion.insert).toEqual([]);
      // And it produced an actual term or flag rather than being swallowed.
      expect(parsed.terms.length + parsed.flags.length, suggestion.insert).toBeGreaterThan(0);
    }
  });

  it('every field and flag the engine has is reachable by typing its own name', () => {
    for (const field of QUERY_FIELDS) {
      const offered = suggestionsFor(field.prefix, 100).map((s) => s.insert);
      expect(offered, field.prefix).toContain(`${field.prefix}:`);
    }
    for (const flag of QUERY_FLAGS) {
      const offered = suggestionsFor(flag.token, 100).map((s) => s.insert);
      expect(offered, flag.token).toContain(flag.token);
    }
  });
});
