// SPDX-License-Identifier: GPL-3.0-or-later

import { foldText } from '@shared/search/index.js';
import { CONTENT_ARTICLES, articleProse } from './content-registry.js';
import type { ContentArticle } from './content-types.js';

/**
 * Search over the help articles.
 *
 * ## Why not `searchCredentials` from `@shared/search`
 *
 * It was the first thing tried, and it does not fit. That engine is typed against
 * `CredentialProjection` — it takes records, folders and tags, ranks over `MATCH_FIELDS`
 * (`username`, `url`, `question`, `deep`…) and its query language is made of credential
 * concepts: `is:favorite`, `has:totp`, `folder:`. An article has none of those, and giving
 * it fake ones to reuse the ranking would be worse than the small function below.
 *
 * What *is* reused is `foldText`, the one genuinely shared piece: case and accent folding.
 * Two different ideas of whether `café` matches `cafe` in the same app would be a real
 * defect, and this is the way to have one idea of it without pretending help articles are
 * credentials.
 *
 * ## Matching is substring, not word-exact
 *
 * Deliberately different from `articleMentions` in the registry, which matches whole words.
 * A search box is used mid-word — someone typing "encrypt" wants the page about encryption
 * — while the unbuilt-feature guard must not fire on *important* when looking for *import*.
 * Same folding, different question, so they are two functions rather than one with a flag.
 */

/** The searchable surfaces, in the order they are worth. */
export const CONTENT_SEARCH_FIELDS = ['title', 'keyword', 'summary', 'body'] as const;

export type ContentSearchField = (typeof CONTENT_SEARCH_FIELDS)[number];

/**
 * Title dominates because it is what the page is called, and someone typing "backups"
 * wants the page named Backups before the four pages that mention backups in passing.
 * Keywords sit second: they exist precisely to catch the word a user reaches for when it
 * is not the word in the title.
 */
export const CONTENT_FIELD_WEIGHTS: Readonly<Record<ContentSearchField, number>> = {
  title: 8,
  keyword: 6,
  summary: 4,
  body: 1,
};

export interface ContentSearchHit {
  readonly article: ContentArticle;
  readonly score: number;
  /** Where the query matched, best field first. For showing why a result is here. */
  readonly matched: readonly ContentSearchField[];
}

interface Haystack {
  readonly title: string;
  readonly keyword: string;
  readonly summary: string;
  readonly body: string;
}

/**
 * Folded once per article per call rather than per term.
 *
 * The set is eight short documents, so this is not a performance necessity; it is here
 * because folding inside the term loop is the version that quietly becomes a problem if the
 * article set ever grows, and the correct shape costs nothing today.
 */
function haystackFor(article: ContentArticle): Haystack {
  return {
    title: foldText(article.title),
    keyword: foldText(article.keywords.join(' ')),
    summary: foldText(article.summary),
    body: foldText(articleProse(article).join(' ')),
  };
}

function fieldsMatching(haystack: Haystack, term: string): readonly ContentSearchField[] {
  return CONTENT_SEARCH_FIELDS.filter((field) => haystack[field].includes(term));
}

/**
 * Ranked articles for a query. Terms are ANDed: every whitespace-separated word must appear
 * somewhere in the article, which is what makes adding a word narrow the list rather than
 * widen it.
 *
 * An empty or whitespace-only query returns every article in registry order, so the index
 * has something to render before anyone types — an empty list would read as "no help".
 */
export function searchContent(
  query: string,
  articles: readonly ContentArticle[] = CONTENT_ARTICLES
): readonly ContentSearchHit[] {
  const terms = foldText(query)
    .split(/\s+/u)
    .filter((term) => term !== '');

  if (terms.length === 0) {
    return articles.map((article) => ({ article, score: 0, matched: [] }));
  }

  const hits: { hit: ContentSearchHit; order: number }[] = [];

  articles.forEach((article, order) => {
    const haystack = haystackFor(article);
    const matched = new Set<ContentSearchField>();
    let score = 0;

    for (const term of terms) {
      const fields = fieldsMatching(haystack, term);
      if (fields.length === 0) return; // AND: one unmatched term drops the article.
      for (const field of fields) matched.add(field);
      // The best field this term appears in, not the sum: a word occurring in the title
      // and again in the body is one reason to rank the article, not two.
      score += Math.max(...fields.map((field) => CONTENT_FIELD_WEIGHTS[field]));
    }

    hits.push({
      hit: {
        article,
        score,
        matched: CONTENT_SEARCH_FIELDS.filter((field) => matched.has(field)),
      },
      order,
    });
  });

  // Registry order breaks ties, so the list never reshuffles between identical queries.
  return hits
    .sort((a, b) => b.hit.score - a.hit.score || a.order - b.order)
    .map((entry) => entry.hit);
}
