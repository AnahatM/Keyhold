// SPDX-License-Identifier: GPL-3.0-or-later

import { useId } from 'react';
import { ContentBlockView } from './ContentBlocks.js';
import {
  CHANGELOG,
  NO_RELEASES,
  changelogTitle,
  preambleBlocks,
  releaseBlocks,
  releaseCaption,
  type Changelog,
} from './changelog.js';
import type { ContentArticleId } from './content-types.js';
import './content.css';

/**
 * The Changelog page — roadmap Phase 16.
 *
 * ## It draws, and decides nothing
 *
 * Every word on this page comes out of `CHANGELOG.md`, by way of `changelog.ts`: the
 * heading is the file's own `#` line, the prose above the releases is the file's own
 * preamble, and each release's body is `releaseBlocks` projecting that section onto the very
 * same `ContentBlock` union the help viewer already draws. The only strings this component
 * contributes are the ones `changelog.ts` exports, and those are checked by
 * `changelog.test.ts` against the real file rather than by rendering anything.
 *
 * That is the point of the whole feature. A hand-maintained changelog screen is correct on
 * the day it is written and wrong at the next release, and the failure is invisible — an app
 * confidently announcing changes it does not contain. Reading the repository's own file at
 * build time is hard rule 8 applied to release notes, and it only works if nothing here
 * quietly adds a second source of truth.
 *
 * As with `AboutView`, it also means the page introduces **no new markup, no new class and
 * therefore no new colour** — every class below is already in `content.css` and already
 * covered by the contrast guard.
 *
 * ## Heading levels, and why the release is an `<h2>`
 *
 * The block model has exactly one heading level: a `heading` block is always an `<h3>`. A
 * release's `### Added` groups are those `<h3>`s, so the version above them has to be an
 * `<h2>`, and the page title above that an `<h1>`. That is the same three-level contract
 * `ContentViewer` and `AboutView` hold, and `ChangelogView.test.tsx` walks the rendered
 * headings to prove no level is skipped in either mounting.
 *
 * `releaseBlocks` is deliberately silent about the version and the date for this reason —
 * they belong to the level above the blocks, so the view renders them and the ordering holds
 * by construction rather than by anyone remembering.
 *
 * ## Nothing here can navigate, and nothing here originates a request
 *
 * `ContentBlockView` takes an `onNavigate` for its `link` blocks, and the changelog produces
 * none: `releaseBlocks` emits only paragraphs, headings and lists, and the parser drops the
 * link-reference definitions at the foot of the file precisely so that repository URLs never
 * arrive here as content. So {@link NO_NAVIGATION} is unreachable rather than merely unused,
 * and a test asserts the rendered page holds no anchor and no cross-reference button — hard
 * rule 5, on the one page whose source document is full of links.
 */

export interface ChangelogViewProps {
  /**
   * From `window.keyhold.app.getVersion()`, by way of whoever mounts this.
   *
   * Optional, and absent is a normal state rather than an error: without it the page simply
   * does not claim which release you are running, which is the honest thing to render when
   * nothing has said. See `releaseCaption`.
   */
  readonly appVersion?: string;
  /** Drops this component's own `<h1>`. Set by a host that already renders the page heading. */
  readonly hideTitle?: boolean;
  /**
   * The parsed changelog. Defaults to the one inlined at build time.
   *
   * A parameter rather than a straight module read so the guards can mount the states the
   * repository's own file does not currently have — a dated release, a version that matches
   * the running build, a changelog that parsed to nothing — without stubbing a module. The
   * app never passes it.
   */
  readonly changelog?: Changelog;
}

/** Never called: see the file header. Present because `ContentBlockView` requires one. */
const NO_NAVIGATION = (_id: ContentArticleId): void => undefined;

export function ChangelogView({
  appVersion,
  hideTitle = false,
  changelog = CHANGELOG,
}: ChangelogViewProps): React.JSX.Element {
  const headingIdPrefix = useId();
  const title = changelogTitle(changelog);

  return (
    <>
      {!hideTitle && <h1 className="kh-content__title">{title}</h1>}

      {/* `data-selectable` because a changelog line is something people quote — into a bug
          report, into a release note — and the app suppresses text selection everywhere
          else. `aria-label` rather than `aria-labelledby`: the article holds one `<h2>` per
          release and no single heading names the whole of it. */}
      <article
        className="kh-content__article kh-content__article--standalone"
        aria-label={title}
        data-selectable="true"
      >
        {preambleBlocks(changelog).map((block, index) => (
          <ContentBlockView
            // Static data assembled in file order by a pure function — the array for a given
            // changelog never reorders, so the index is a stable identity.
            key={index}
            block={block}
            onNavigate={NO_NAVIGATION}
          />
        ))}

        {changelog.releases.length === 0 ? (
          <ContentBlockView block={NO_RELEASES} onNavigate={NO_NAVIGATION} />
        ) : (
          changelog.releases.map((release, index) => {
            const headingId = `${headingIdPrefix}-${String(index)}`;
            return (
              <section key={index} className="kh-content__release" aria-labelledby={headingId}>
                {/*
                  Its own class rather than a borrowed one. `.kh-content__heading` is the
                  `<h3>` rule and was the only thing in `content.css` putting space above a
                  heading, so borrowing it separated the releases at the cost of rendering a
                  version at the same size as the group headings beneath it — an `<h2>` that
                  looks like an `<h3>` is a heading level the eye cannot see.
                */}
                <h2 className="kh-content__release-title" id={headingId}>
                  {release.version}
                </h2>
                <p className="kh-content__lead">{releaseCaption(release, appVersion)}</p>

                {releaseBlocks(release).map((block, blockIndex) => (
                  <ContentBlockView key={blockIndex} block={block} onNavigate={NO_NAVIGATION} />
                ))}
              </section>
            );
          })
        )}
      </article>
    </>
  );
}
