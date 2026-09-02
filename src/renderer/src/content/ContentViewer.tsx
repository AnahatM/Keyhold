// SPDX-License-Identifier: GPL-3.0-or-later

import { useId, useMemo, useState } from 'react';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { ArticleLink, ContentBlockView } from './ContentBlocks.js';
import { DEFAULT_ARTICLE_ID, findArticle } from './content-registry.js';
import { searchContent } from './content-search.js';
import type { ContentArticleId } from './content-types.js';
import './content.css';

/**
 * The help viewer: an index on the left, the selected article on the right.
 *
 * Three decisions worth recording.
 *
 * **The selected article is never changed by searching.** Filtering the index while leaving
 * the reading pane alone means a search cannot yank the page out from under someone who is
 * halfway through it — and it avoids the alternative, which is an effect that watches the
 * results and calls `setState`, cascading a render on every keystroke. Nothing here runs an
 * effect at all.
 *
 * **The index is a list of buttons**, so Tab reaches every entry and Enter and Space both
 * activate one, with no key handling of our own to get wrong. A roving-tabindex grid would
 * be fewer tab stops and one more thing that can trap a keyboard user in a corner of the
 * screen.
 *
 * **Mount it as its own view.** It renders the page's `<h1>`, and each article's title as
 * an `<h2>` beneath it, so the heading order only holds if nothing above it has already
 * claimed the `<h1>`.
 */
export interface ContentViewerProps {
  /** Which article to open with. Defaults to the getting-started page. */
  readonly initialArticleId?: ContentArticleId;
  /**
   * Shown beside the title when supplied.
   *
   * Passed in rather than read here: the version comes from the main process over the
   * bridge, and an offline content layer that could not be rendered without an await would
   * be a worse thing to have built.
   */
  readonly appVersion?: string;
  /** Renders a close control when given. Omitted when the help is a permanent view. */
  readonly onClose?: () => void;
}

export function ContentViewer({
  initialArticleId = DEFAULT_ARTICLE_ID,
  appVersion,
  onClose,
}: ContentViewerProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<ContentArticleId>(initialArticleId);

  const hits = useMemo(() => searchContent(query), [query]);
  const article = findArticle(selectedId);

  const titleId = useId();
  const indexLabelId = useId();

  return (
    <div className="kh-content">
      <header className="kh-content__header">
        <div>
          <h1 className="kh-content__title">Keyhold Help</h1>
          <p className="kh-content__subtitle">
            Everything here ships inside the app. Nothing on this page needs a connection.
            {appVersion === undefined ? '' : ` Version ${appVersion}.`}
          </p>
        </div>
        {onClose !== undefined && (
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        )}
      </header>

      <div className="kh-content__body">
        <nav className="kh-content__index" aria-labelledby={indexLabelId}>
          <h2 className="kh-visually-hidden" id={indexLabelId}>
            Help articles
          </h2>

          <Input
            label="Search help"
            type="search"
            value={query}
            placeholder="backups, forgotten password, encryption…"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />

          {hits.length === 0 ? (
            <p className="kh-content__no-results" role="status">
              Nothing matched “{query}”. Try a single word — the search covers every page’s title,
              summary and full text.
            </p>
          ) : (
            <ul className="kh-content__index-list">
              {hits.map(({ article: entry }) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="kh-content__index-item"
                    // `aria-current="page"` rather than a colour change alone, so the
                    // selected entry is announced as the one being read.
                    aria-current={entry.id === selectedId ? 'page' : undefined}
                    onClick={() => {
                      setSelectedId(entry.id);
                    }}
                  >
                    <span className="kh-content__index-title">{entry.title}</span>
                    <span className="kh-content__index-summary">{entry.summary}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>

        {/* `key` remounts on navigation so the pane is scrolled to the top of the new
            article rather than left wherever the previous one was read to. */}
        <article
          key={article.id}
          className="kh-content__article kh-scroll-y"
          aria-labelledby={titleId}
          data-selectable="true"
        >
          <h2 className="kh-content__article-title" id={titleId}>
            {article.title}
          </h2>
          <p className="kh-content__lead">{article.summary}</p>

          {article.body.map((block, index) => (
            <ContentBlockView
              // Blocks are static data with no identity of their own, and the array for a
              // given article never reorders — it is a literal in a module.
              key={index}
              block={block}
              onNavigate={setSelectedId}
            />
          ))}

          {article.related.length > 0 && (
            <nav className="kh-content__related" aria-label="Related help">
              <h3 className="kh-content__heading">Related</h3>
              <ul className="kh-content__related-list">
                {article.related.map((id) => (
                  <li key={id}>
                    <ArticleLink id={id} label={findArticle(id).title} onNavigate={setSelectedId} />
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </article>
      </div>
    </div>
  );
}
