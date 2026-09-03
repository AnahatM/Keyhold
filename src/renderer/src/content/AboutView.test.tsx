// SPDX-License-Identifier: GPL-3.0-or-later

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountReact, type MountedTree } from '../chrome/test-dom.js';
import { AboutView } from './AboutView.js';
import { PROJECT, type AboutLicence } from './about-facts.js';

/**
 * What the About page actually puts on screen.
 *
 * `about-facts.test.ts` proves the page's *claims* are the repository's own; this proves the
 * component does not lose them between the pure function and the DOM, and that the two things
 * a rendered page can get wrong independently of its content are right: the heading order,
 * and whether a control that looks operable is.
 *
 * `@testing-library/react` is not a dependency of this project, so this renders through
 * `react-dom/client` via `chrome/test-dom.ts` — the same trade the app chrome made rather
 * than taking on a testing library for one screen.
 *
 * Fault injections performed against these guards, all caught and all reverted. Counts are
 * the failures in this file:
 *
 *   | Injection                                                        | Result |
 *   |------------------------------------------------------------------|--------|
 *   | the page's `<h2>` changed to an `<h4>`                            | 2 failed — both mounted cases; `heading order jumped past h2: expected 4 to be less than or equal to 2` |
 *   | `hideTitle` ignored, so the `<h1>` always renders                 | 1 failed — `expected [ 1, 2, 3, 3, 3 ] to not include 1` |
 *   | `canOpenArticle` hard-wired to `true`                             | 1 failed — `expected <button …> to have a length of +0 but got 1`, a cross-reference with `NO_NAVIGATION` behind it |
 *   | `licences` forwarded as `[]` rather than as given                 | 2 failed — `@zxcvbn-ts/core never reached the markup`, and the missing-list callout |
 *   | `appVersion` forwarded as `appVersion?.slice(0, 3)`               | 1 failed — `expected '…' to contain '1.4.2-beta.3'` |
 */

const LICENCES: readonly AboutLicence[] = [
  { name: '@zxcvbn-ts/core', version: '4.2.0', licence: 'MIT', direct: true, problem: null },
  { name: 'scheduler', version: '0.27.0', licence: 'MIT', direct: false, problem: null },
];

let tree: MountedTree | null = null;

afterEach(() => {
  tree?.unmount();
  tree = null;
});

function headingLevels(container: HTMLElement): readonly number[] {
  return [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((node) =>
    Number(node.tagName.slice(1))
  );
}

/** The whole page as text, the way a reader meets it. */
function text(container: HTMLElement): string {
  return container.textContent;
}

describe('heading order', () => {
  /**
   * The rule, stated once: the first heading is the top of the page and no later one skips a
   * level. Written as a property over whatever is rendered rather than as "there is an h2
   * here" — a per-element assertion cannot catch a *new* section arriving at the wrong level,
   * which is the way this actually breaks.
   */
  const neverSkips = (levels: readonly number[], top: number): void => {
    expect(levels[0]).toBe(top);
    let deepest = top;
    for (const level of levels) {
      expect(level, `heading order jumped past h${deepest + 1}`).toBeLessThanOrEqual(deepest + 1);
      deepest = Math.max(deepest, level);
    }
  };

  it('starts at h1 and steps one level at a time when it owns the title', () => {
    tree = mountReact(<AboutView appVersion="0.1.0" licences={LICENCES} />);
    const levels = headingLevels(tree.container);
    expect(levels.filter((level) => level === 1)).toHaveLength(1);
    neverSkips(levels, 1);
  });

  it('starts at h2 when the frame above it owns the h1', () => {
    tree = mountReact(<AboutView hideTitle appVersion="0.1.0" licences={LICENCES} />);
    const levels = headingLevels(tree.container);
    expect(levels).not.toContain(1);
    neverSkips(levels, 2);
  });
});

describe('what reaches the screen', () => {
  it('renders the version it was given', () => {
    tree = mountReact(<AboutView hideTitle appVersion="1.4.2-beta.3" licences={LICENCES} />);
    expect(text(tree.container)).toContain('1.4.2-beta.3');
  });

  it('renders the byline and every address, as copyable text rather than links', () => {
    tree = mountReact(<AboutView hideTitle appVersion="0.1.0" licences={LICENCES} />);
    const rendered = text(tree.container);

    expect(rendered).toContain(PROJECT.authorName);
    expect(rendered).toContain(PROJECT.sourceUrl);
    expect(rendered).toContain(PROJECT.issuesUrl);
    expect(rendered).toContain(PROJECT.securityUrl);

    // Hard rule 5. Nothing on this page may originate a request, so no address is an anchor
    // and there is no href for a click to follow.
    expect(tree.container.querySelectorAll('a')).toHaveLength(0);
  });

  it('renders every third-party package it was handed', () => {
    tree = mountReact(<AboutView hideTitle appVersion="0.1.0" licences={LICENCES} />);
    const rendered = text(tree.container);
    for (const item of LICENCES) {
      expect(rendered, `${item.name} never reached the markup`).toContain(item.name);
      expect(rendered).toContain(item.version);
    }
  });

  it('says the licence list is missing rather than rendering an empty section', () => {
    tree = mountReact(<AboutView hideTitle appVersion="0.1.0" />);
    const callouts = tree.container.querySelectorAll('.kh-content__callout--not-built');
    expect(callouts).toHaveLength(1);
    expect(callouts[0]?.textContent ?? '').toContain('Not built yet');
  });
});

describe('the cross-reference is never a dead control', () => {
  it('renders no link when the host cannot open an article', () => {
    tree = mountReact(<AboutView hideTitle appVersion="0.1.0" licences={LICENCES} />);
    expect(tree.container.querySelectorAll('.kh-content__link')).toHaveLength(0);
  });

  it('renders one that opens the about article when it can', async () => {
    const onOpenArticle = vi.fn();
    tree = mountReact(
      <AboutView hideTitle appVersion="0.1.0" licences={LICENCES} onOpenArticle={onOpenArticle} />
    );

    const links = tree.container.querySelectorAll<HTMLButtonElement>('.kh-content__link');
    expect(links).toHaveLength(1);

    await act(async () => {
      links[0]?.click();
      await Promise.resolve();
    });

    expect(onOpenArticle).toHaveBeenCalledExactlyOnceWith('about');
  });
});
