// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The in-app content layer — roadmap Phase 16.
 *
 * Help articles as a registry plus one viewer, so every page comes from a single list
 * rather than being hand-placed in JSX. A barrel because this is consumed from outside the
 * folder (the help view, and later the command palette and the menu), and one import site
 * is what stops a second copy of "the list of pages" appearing somewhere else.
 *
 * What is here, and what is not:
 *
 *   - **Here:** the eight help articles, the viewer, the search, and the registry of
 *     features that are described but not yet built.
 *   - **Not here, and still on Phase 16:** the changelog view rendered from `CHANGELOG.md`,
 *     the generated third-party licence list, and the first-run onboarding tour.
 */

export { ContentViewer, type ContentViewerProps } from './ContentViewer.js';
export {
  CONTENT_ARTICLES,
  DEFAULT_ARTICLE_ID,
  articleLinkTargets,
  articleMentions,
  articleProse,
  declaredUnbuilt,
  findArticle,
  toWords,
} from './content-registry.js';
export {
  CONTENT_FIELD_WEIGHTS,
  CONTENT_SEARCH_FIELDS,
  searchContent,
  type ContentSearchField,
  type ContentSearchHit,
} from './content-search.js';
export {
  CONTENT_ARTICLE_IDS,
  type ContentArticle,
  type ContentArticleId,
  type ContentBlock,
  type ContentFactRow,
  type ContentNoteTone,
} from './content-types.js';
export {
  UNBUILT_FEATURES,
  UNBUILT_FEATURE_IDS,
  type UnbuiltFeature,
  type UnbuiltFeatureId,
} from './feature-status.js';
export { SHORTCUT_COUNT, SHORTCUT_SCOPE_ROWS } from './shortcuts-source.js';

export { AboutView, type AboutViewProps } from './AboutView.js';
export {
  ABOUT_SUMMARY,
  ABOUT_TITLE,
  PROJECT,
  VERSION_UNAVAILABLE,
  aboutBlocks,
  isUnresolved,
  licenceCounts,
  licenceRow,
  licenceSummarySentence,
  type AboutFactsInput,
  type AboutLicence,
  type LicenceCounts,
} from './about-facts.js';
