// SPDX-License-Identifier: GPL-3.0-or-later

import { foldText } from '@shared/search/index.js';
import {
  CONTENT_ARTICLE_IDS,
  type ContentArticle,
  type ContentArticleId,
} from './content-types.js';
import { UNBUILT_FEATURES, type UnbuiltFeatureId } from './feature-status.js';
import { aboutArticle } from './articles/about.js';
import { backupsAndDevicesArticle } from './articles/backups-and-devices.js';
import { gettingStartedArticle } from './articles/getting-started.js';
import { historyAndAuditArticle } from './articles/history-and-audit.js';
import { howYourDataIsProtectedArticle } from './articles/how-your-data-is-protected.js';
import { keyboardShortcutsArticle } from './articles/keyboard-shortcuts.js';
import { masterPasswordArticle } from './articles/master-password.js';
import { troubleshootingArticle } from './articles/troubleshooting.js';

/**
 * The one list of help articles.
 *
 * Every surface that shows help — the index, the search, a future command palette entry,
 * the tests — reads from here. Nothing hand-places an article in JSX, which is the whole
 * point of the layer: adding a page is adding an entry, and forgetting to link it up
 * somewhere is not a failure mode that exists.
 *
 * Keyed by `ContentArticleId` rather than collected into an array, so an id declared in
 * `CONTENT_ARTICLE_IDS` with no article behind it is a compile error. The reverse — an
 * article whose own `id` does not match its key — is not expressible in the type system,
 * so `content-registry.test.ts` asserts it.
 */
const ARTICLES_BY_ID: Record<ContentArticleId, ContentArticle> = {
  'getting-started': gettingStartedArticle,
  'how-your-data-is-protected': howYourDataIsProtectedArticle,
  'master-password': masterPasswordArticle,
  'backups-and-devices': backupsAndDevicesArticle,
  'history-and-audit': historyAndAuditArticle,
  'keyboard-shortcuts': keyboardShortcutsArticle,
  troubleshooting: troubleshootingArticle,
  about: aboutArticle,
};

/** Reading order, which is also index order and the tiebreak for equally-ranked search hits. */
export const CONTENT_ARTICLES: readonly ContentArticle[] = CONTENT_ARTICLE_IDS.map(
  (id) => ARTICLES_BY_ID[id]
);

export function findArticle(id: ContentArticleId): ContentArticle {
  return ARTICLES_BY_ID[id];
}

/** The first article shown when the help opens with nothing selected. */
export const DEFAULT_ARTICLE_ID: ContentArticleId = 'getting-started';

// ── Deriving things from an article ──────────────────────────────────────────

/**
 * Every human-readable string in an article's body, in reading order.
 *
 * Used by the search index and by the "does this article mention an unbuilt feature" guard.
 * One extractor for both, so a block kind that becomes searchable also becomes checkable,
 * and neither can quietly stop covering a kind the other still sees.
 */
export function articleProse(article: ContentArticle): readonly string[] {
  const out: string[] = [];
  for (const block of article.body) {
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
        out.push(block.text);
        break;
      case 'list':
      case 'steps':
        out.push(...block.items);
        break;
      case 'facts':
        for (const row of block.rows) out.push(row.term, row.description);
        break;
      case 'note':
        out.push(block.label, block.text);
        break;
      case 'not-built':
        // The feature's own label is rendered in the callout, so it is part of the prose a
        // reader sees and part of what search should be able to find.
        out.push(UNBUILT_FEATURES[block.feature].label, block.text);
        break;
      case 'link':
        out.push(block.text);
        break;
    }
  }
  return out;
}

/** Every other article this one points at, from both its `related` list and its link blocks. */
export function articleLinkTargets(article: ContentArticle): readonly ContentArticleId[] {
  const fromBlocks = article.body.flatMap((block) => (block.kind === 'link' ? [block.to] : []));
  return [...article.related, ...fromBlocks];
}

/** The unbuilt features this article explicitly marks. */
export function declaredUnbuilt(article: ContentArticle): ReadonlySet<UnbuiltFeatureId> {
  return new Set(
    article.body.flatMap((block) => (block.kind === 'not-built' ? [block.feature] : []))
  );
}

// ── Word matching ────────────────────────────────────────────────────────────

/**
 * Folds text into a list of words.
 *
 * `foldText` comes from `@shared/search`, so casing and accents are handled exactly as they
 * are in the credential search rather than by a second, subtly different implementation.
 * The split is on anything that is not a letter or a digit, which is what makes phrase
 * matching word-based: `.keepx` becomes `keepx`, and crucially *important* does not contain
 * the word *import*.
 */
export function toWords(value: string): readonly string[] {
  return foldText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
}

function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** True when the article's prose contains the phrase as a run of whole words. */
export function articleMentions(article: ContentArticle, phrase: string): boolean {
  const needle = toWords(phrase);
  return articleProse(article).some((text) => containsSequence(toWords(text), needle));
}
