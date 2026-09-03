// SPDX-License-Identifier: GPL-3.0-or-later

import { useId } from 'react';
import { ContentBlockView } from './ContentBlocks.js';
import { ABOUT_SUMMARY, ABOUT_TITLE, aboutBlocks, type AboutLicence } from './about-facts.js';
import type { ContentArticleId } from './content-types.js';
import './content.css';

/**
 * The About page — roadmap Phase 16.
 *
 * ## It draws, and decides nothing
 *
 * Every sentence on this page comes from `about-facts.ts`, which is a pure function guarded
 * by `about-facts.test.ts` against the manifest, `SECURITY.md` and `LICENSE`. This file maps
 * the blocks that function returns onto the block renderer the help viewer already uses. That
 * is the whole component, and it is deliberate: a claim about a licence or a byline should be
 * checkable without mounting React, and a page that assembled its own facts in JSX would not
 * be.
 *
 * It also means the page introduces **no new markup, no new class and therefore no new
 * colour** — it reuses `.kh-content__article` and the block classes in `content.css`, every
 * one of which is already covered by the contrast guard.
 *
 * ## The frame owns the `<h1>`
 *
 * Same contract as `ContentViewer`: mounted as a tool view, `ToolView` renders the page's
 * `<h1>` and takes focus on navigation, so this renders an `<h2>` and the blocks render
 * `<h3>`s beneath it. Mounted anywhere else, `hideTitle` is left off and this renders the
 * `<h1>` itself. Exactly one of the two, always — a skipped level is a WCAG 1.3.1 failure and
 * `AboutView.test.tsx` walks the rendered headings to prove it does not happen.
 *
 * ## Nothing here originates a request
 *
 * The repository, issue tracker and security-advisory addresses render as **text**. Not an
 * oversight: hard rule 5 is zero network by default, and this page is the last place that
 * should be the first to reach outward. A reader who wants one copies it.
 */

export interface AboutViewProps {
  /**
   * From `window.keyhold.app.getVersion()`.
   *
   * Passed in rather than read here, for the reason `ContentViewer` gives about the same
   * value: it arrives over the bridge as a promise, and an offline page that could not render
   * without an await would be a worse thing to have built. When it is absent the page says
   * so — see `VERSION_UNAVAILABLE`.
   */
  readonly appVersion?: string;
  /**
   * The third-party notice, derived by `tools/licences.ts`.
   *
   * `undefined` while nothing supplies it, which the page reports as an unbuilt feature
   * rather than by rendering an empty section.
   */
  readonly licences?: readonly AboutLicence[];
  /**
   * Opens a help article. Supplied by a host that can show one.
   *
   * When it is omitted, the cross-reference is not rendered at all rather than rendered
   * inert: `aboutBlocks` is told whether navigation exists and emits no `link` block without
   * it, so `NO_NAVIGATION` below can never actually be reached.
   */
  readonly onOpenArticle?: (id: ContentArticleId) => void;
  /** Drops this component's own `<h1>`. Set by a host that already renders the page heading. */
  readonly hideTitle?: boolean;
}

const NO_NAVIGATION = (): void => undefined;

export function AboutView({
  appVersion,
  licences,
  onOpenArticle,
  hideTitle = false,
}: AboutViewProps): React.JSX.Element {
  const titleId = useId();

  const blocks = aboutBlocks({
    appVersion,
    licences,
    canOpenArticle: onOpenArticle !== undefined,
  });

  return (
    <>
      {!hideTitle && <h1 className="kh-content__title">About Keyhold</h1>}

      {/* `data-selectable` because every address on this page is meant to be copied, and
          the app suppresses text selection everywhere else. */}
      <article className="kh-content__article" aria-labelledby={titleId} data-selectable="true">
        <h2 className="kh-content__article-title" id={titleId}>
          {ABOUT_TITLE}
        </h2>
        <p className="kh-content__lead">{ABOUT_SUMMARY}</p>

        {blocks.map((block, index) => (
          <ContentBlockView
            // Static data with no identity of its own, assembled in a fixed order by a pure
            // function — the array for a given set of props never reorders.
            key={index}
            block={block}
            onNavigate={onOpenArticle ?? NO_NAVIGATION}
          />
        ))}
      </article>
    </>
  );
}
