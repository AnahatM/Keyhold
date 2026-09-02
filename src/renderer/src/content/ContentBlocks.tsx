// SPDX-License-Identifier: GPL-3.0-or-later

import { findArticle } from './content-registry.js';
import { UNBUILT_FEATURES } from './feature-status.js';
import type { ContentArticleId, ContentBlock } from './content-types.js';

/**
 * One block, rendered.
 *
 * Every branch produces a native element with its meaning already in it — `<ol>` for steps,
 * `<dl>` for facts, `<h3>` for a heading — rather than a styled `<div>` with an ARIA role
 * bolted on. That is the design system's rule (ARIA only where native will not do), and
 * here it is also what keeps heading order correct without anyone having to think about it:
 * the block model has exactly one heading level, so an article cannot skip from `<h2>` to
 * `<h4>`.
 *
 * The two callouts carry a **written label**, not just a tint. A reader who cannot
 * distinguish the colours, or who is using the high-contrast theme, still gets "Not built
 * yet" in words (WCAG 1.4.1).
 */
export function ContentBlockView({
  block,
  onNavigate,
}: {
  readonly block: ContentBlock;
  readonly onNavigate: (id: ContentArticleId) => void;
}): React.JSX.Element {
  switch (block.kind) {
    case 'paragraph':
      return <p className="kh-content__paragraph">{block.text}</p>;

    case 'heading':
      return <h3 className="kh-content__heading">{block.text}</h3>;

    case 'list':
      return (
        <ul className="kh-content__list">
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );

    case 'steps':
      return (
        <ol className="kh-content__steps">
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      );

    case 'facts':
      return (
        <dl className="kh-content__facts">
          {block.rows.map((row) => (
            <div key={row.term} className="kh-content__fact">
              <dt>{row.term}</dt>
              <dd>{row.description}</dd>
            </div>
          ))}
        </dl>
      );

    case 'note':
      return (
        <div className={`kh-content__callout kh-content__callout--${block.tone}`}>
          <p className="kh-content__callout-label">{block.label}</p>
          <p className="kh-content__callout-text">{block.text}</p>
        </div>
      );

    case 'not-built': {
      const feature = UNBUILT_FEATURES[block.feature];
      return (
        <div className="kh-content__callout kh-content__callout--not-built">
          <p className="kh-content__callout-label">
            Not built yet — {feature.label}
            <span className="kh-content__callout-meta"> ({feature.roadmap})</span>
          </p>
          <p className="kh-content__callout-text">{block.text}</p>
        </div>
      );
    }

    case 'link':
      return (
        <p className="kh-content__inline-link">
          <ArticleLink id={block.to} label={block.text} onNavigate={onNavigate} />
        </p>
      );
  }
}

/**
 * A cross-reference.
 *
 * A `<button>`, not an `<a>`: nothing here navigates a document, and an anchor with no
 * href is announced as plain text. The article's own title is appended as a visually hidden
 * suffix so a screen reader reading links out of context knows where each one goes.
 */
export function ArticleLink({
  id,
  label,
  onNavigate,
}: {
  readonly id: ContentArticleId;
  readonly label: string;
  readonly onNavigate: (target: ContentArticleId) => void;
}): React.JSX.Element {
  const article = findArticle(id);
  return (
    <button
      type="button"
      className="kh-content__link"
      onClick={() => {
        onNavigate(id);
      }}
    >
      <span aria-hidden="true" className="kh-content__link-mark">
        →
      </span>
      {label}
      {label === article.title ? null : (
        <span className="kh-visually-hidden"> — opens “{article.title}”</span>
      )}
    </button>
  );
}
