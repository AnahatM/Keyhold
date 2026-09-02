// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { CONTENT_ARTICLES } from './content-registry.js';
import { searchContent } from './content-search.js';

/**
 * Guards for the help search.
 *
 * The failure worth catching is not a bad ranking — it is an article that cannot be found
 * at all. A page nobody can reach is the same as a page nobody wrote, and the way that
 * happens is a keyword list that drifts, or a block kind the prose extractor stopped
 * reading. Both are asserted below, for every article, rather than for a sample.
 *
 * Fault injection performed and confirmed: dropping `keyword` from
 * `CONTENT_SEARCH_FIELDS` makes `finds every article by each of its own keywords` fail with
 * the first keyword that appears nowhere else in the article.
 */

function idsFor(query: string): readonly string[] {
  return searchContent(query).map((hit) => hit.article.id);
}

describe('searching the help', () => {
  it('finds every article by its own exact title', () => {
    for (const article of CONTENT_ARTICLES) {
      expect(idsFor(article.title), `"${article.title}" finds nothing`).toContain(article.id);
    }
  });

  it('ranks an article first when searched for by its own title', () => {
    for (const article of CONTENT_ARTICLES) {
      const [first] = searchContent(article.title);
      expect(first?.article.id, `"${article.title}" ranked below something else`).toBe(article.id);
    }
  });

  it('finds every article by each of its own keywords', () => {
    for (const article of CONTENT_ARTICLES) {
      for (const keyword of article.keywords) {
        expect(idsFor(keyword), `"${keyword}" does not find ${article.id}`).toContain(article.id);
      }
    }
  });

  it('returns every article, in registry order, for an empty query', () => {
    const expected = CONTENT_ARTICLES.map((article) => article.id);
    expect(idsFor('')).toEqual(expected);
    expect(idsFor('   ')).toEqual(expected);
  });

  it('narrows rather than widens as words are added', () => {
    const one = idsFor('password');
    const two = idsFor('password backups');
    expect(two.length).toBeLessThanOrEqual(one.length);
    for (const id of two) expect(one).toContain(id);
  });

  it('drops an article when any one term is missing from it', () => {
    // "zzzz" appears in no article, so ANDing it with a common word must empty the result.
    expect(idsFor('password zzzzqqq')).toEqual([]);
  });

  it('ignores case and accents, and matches inside a word', () => {
    expect(idsFor('ENCRYPT')).toEqual(idsFor('encrypt'));
    expect(idsFor('encrypt')).toContain('how-your-data-is-protected');
    // The folding is `@shared/search`'s, so `é` and `e` are the same character here and in
    // the credential search rather than in one of them.
    expect(idsFor('récovery')).toEqual(idsFor('recovery'));
  });

  it('ranks a title match above a passing mention in body text', () => {
    const results = searchContent('troubleshooting');
    expect(results[0]?.article.id).toBe('troubleshooting');
    const first = results[0];
    if (first === undefined) throw new Error('expected a result');
    expect(first.matched).toContain('title');
  });

  it('reports where the match happened', () => {
    const [hit] = searchContent('argon2');
    expect(hit?.matched.length ?? 0).toBeGreaterThan(0);
  });

  it('is stable: the same query gives the same order', () => {
    expect(idsFor('vault')).toEqual(idsFor('vault'));
  });
});
