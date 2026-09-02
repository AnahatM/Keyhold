// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The in-app content layer — roadmap Phase 16.
 *
 * ## Why a block model rather than Markdown
 *
 * Help text has to ship inside the bundle (hard rule 5 — zero network), so it cannot be
 * fetched, and rendering it means either a Markdown dependency or a hand-rolled parser.
 * A dependency is supply-chain surface for a security tool, and a hand-rolled parser is a
 * new place for `dangerouslySetInnerHTML` to seem reasonable.
 *
 * So the body of an article is **data, not text**: a short list of typed blocks that map
 * one-to-one onto elements. That buys three things Markdown would not:
 *
 *  - **Nothing is parsed**, so nothing renders as HTML and no sanitiser is needed.
 *  - **Structure is checkable.** A test can assert that the privacy-level table matches
 *    `AUDIT_LEVEL_FIELDS`, or that an article mentioning an unbuilt feature carries the
 *    marker saying so. Prose in a string is opaque to a guard test; blocks are not.
 *  - **Heading order cannot drift.** There is no `####`; a `heading` block is always an
 *    `<h3>` under the article's `<h2>`, so WCAG 1.3.1 holds by construction.
 *
 * ### What the format deliberately does NOT support
 *
 * No inline formatting of any kind: no bold, no italics, no inline code, no inline links,
 * no images, no tables beyond the flat `facts` list, and no nesting. A cross-reference is
 * its own `link` block, because a link a reader can miss inside a paragraph is a link they
 * will not follow, and because a typed target is what lets the dead-link test exist. If a
 * sentence needs emphasis to be understood, the sentence is wrong.
 */

import type { UnbuiltFeatureId } from './feature-status.js';

/**
 * Every article id, once.
 *
 * The union is the source of truth and the registry must cover it exactly — declared here
 * rather than inferred from the registry so that a cross-link to an article nobody has
 * written yet is a compile error, not a button that does nothing.
 */
export const CONTENT_ARTICLE_IDS = [
  'getting-started',
  'how-your-data-is-protected',
  'master-password',
  'backups-and-devices',
  'history-and-audit',
  'keyboard-shortcuts',
  'troubleshooting',
  'about',
] as const;

export type ContentArticleId = (typeof CONTENT_ARTICLE_IDS)[number];

/** Matches the status tones the design system already defines. Never colour alone. */
export type ContentNoteTone = 'info' | 'warning' | 'danger';

export interface ContentFactRow {
  readonly term: string;
  readonly description: string;
}

/**
 * One renderable unit.
 *
 * `not-built` is a separate kind from `note` on purpose. It is the one callout whose
 * accuracy a test can enforce, and giving it its own kind is what lets the registry ask
 * "does this article mention a feature that does not exist, and does it say so?".
 */
export type ContentBlock =
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] }
  | { readonly kind: 'steps'; readonly items: readonly string[] }
  | { readonly kind: 'facts'; readonly rows: readonly ContentFactRow[] }
  | {
      readonly kind: 'note';
      readonly tone: ContentNoteTone;
      /** Read out before the text, so the meaning does not depend on the tint. */
      readonly label: string;
      readonly text: string;
    }
  | { readonly kind: 'not-built'; readonly feature: UnbuiltFeatureId; readonly text: string }
  | { readonly kind: 'link'; readonly to: ContentArticleId; readonly text: string };

export interface ContentArticle {
  readonly id: ContentArticleId;
  /** Also the search's highest-weighted field, so it has to read like what someone types. */
  readonly title: string;
  /** One sentence. Shown in the index under the title, and searched. */
  readonly summary: string;
  /**
   * The words a user would search for that are not already in the title or the body —
   * synonyms, the wrong-but-common name for a thing, the panicked phrasing.
   */
  readonly keywords: readonly string[];
  readonly body: readonly ContentBlock[];
  /**
   * Further reading. Every id must resolve to a real article — a dead in-app link is worse
   * than no link, so there is a test rather than a convention.
   */
  readonly related: readonly ContentArticleId[];
}
