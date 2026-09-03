// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import { mountReact, type MountedTree } from '../chrome/test-dom.js';
import { ChangelogView } from './ChangelogView.js';
import { CHANGELOG, CHANGELOG_FALLBACK_TITLE, parseChangelog } from './changelog.js';

/**
 * What the Changelog page actually puts on screen.
 *
 * `changelog.test.ts` proves the parser reads `CHANGELOG.md` without dropping anything and
 * that the page's own strings are true; this proves the component does not lose any of it
 * between the pure module and the DOM. The division matters, because the two halves fail
 * differently: a parser bug loses a line, and a *view* bug loses a whole release — the map
 * that never ran, the branch that swallowed the list — and neither throws.
 *
 * The headline guard is `every entry in the real file reaches the screen`. It is deliberately
 * driven off `CHANGELOG` rather than a fixture: the promise this feature makes is about the
 * repository's own file, and a fixture-only test would still pass on the day a real entry
 * stopped rendering.
 *
 * `@testing-library/react` is not a dependency of this project, so this renders through
 * `react-dom/client` via `chrome/test-dom.ts` — the same trade `AboutView.test.tsx` made.
 *
 * Fault injections performed against these guards, all caught and all reverted. Counts are
 * the failures in this file; the exact assertion messages are recorded in the task report.
 *
 *   | Injection                                                          | Result |
 *   |--------------------------------------------------------------------|--------|
 *   | the release `<h2>` changed to an `<h4>`                             | 2 failed — both mountings; `heading order jumped past h2` |
 *   | `hideTitle` ignored, so the `<h1>` always renders                   | 1 failed — `expected [ 1, 2, 3, … ] to not include 1` |
 *   | the `releaseBlocks(...)` map dropped from the section               | 2 failed — the real file's entries, and the group headings |
 *   | `preambleBlocks(...)` map dropped                                   | 1 failed — the file's own preamble never reached the page |
 *   | `releaseCaption` called without `appVersion`                        | 1 failed — the running build was never named |
 *   | the empty-release branch removed, so `[]` renders as nothing        | 1 failed — no callout, and a silently blank page |
 *   | `aria-labelledby` pointed at a stale id                             | 1 failed — a release section named by nothing |
 */

const DATED = parseChangelog(
  [
    '# Changelog',
    '',
    'Everything worth knowing.',
    '',
    '## [1.2.0] - 2026-09-15',
    '',
    '### Added',
    '',
    '- A thing that was added.',
    '',
    '## [1.0.0] - 2026-01-02',
    '',
    '### Fixed',
    '',
    '- A thing that was broken.',
    '',
  ].join('\n')
);

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
   * The same property `AboutView.test.tsx` states: the first heading is the top of the page
   * and no later one skips a level. Written over whatever is rendered rather than as "there
   * is an h2 here", because the way this breaks is a *new* section arriving at the wrong
   * level — and this page grows a new section every release.
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
    tree = mountReact(<ChangelogView />);
    const levels = headingLevels(tree.container);
    expect(levels.filter((level) => level === 1)).toHaveLength(1);
    neverSkips(levels, 1);
  });

  it('starts at h2 when the frame above it owns the h1', () => {
    tree = mountReact(<ChangelogView hideTitle />);
    const levels = headingLevels(tree.container);
    expect(levels).not.toContain(1);
    neverSkips(levels, 2);
  });

  it('puts every release at h2, above the group headings the block model renders at h3', () => {
    tree = mountReact(<ChangelogView hideTitle changelog={DATED} />);
    expect([...tree.container.querySelectorAll('h2')].map((node) => node.textContent)).toEqual(
      DATED.releases.map((release) => release.version)
    );
    expect([...tree.container.querySelectorAll('h3')].map((node) => node.textContent)).toEqual(
      DATED.releases.flatMap((release) => release.groups.map((group) => group.heading))
    );
  });
});

describe('the real CHANGELOG.md reaches the screen', () => {
  it('renders every entry in the file, not a summary of them', () => {
    // The assertion the whole feature rests on. A dropped map, a swallowed group or a
    // release rendered as its heading alone all move this, and none of them throws.
    tree = mountReact(<ChangelogView hideTitle />);
    const rendered = text(tree.container);

    const entries = CHANGELOG.releases.flatMap((release) =>
      release.groups.flatMap((group) => group.entries)
    );
    expect(entries.length, 'the fixture-free case parsed to nothing').toBeGreaterThan(25);
    for (const entry of entries) {
      expect(rendered, 'an entry never reached the markup').toContain(entry);
    }
  });

  it('renders every group heading and every version', () => {
    tree = mountReact(<ChangelogView hideTitle />);
    const rendered = text(tree.container);
    for (const release of CHANGELOG.releases) {
      expect(rendered, `${release.version} is missing`).toContain(release.version);
      for (const group of release.groups) expect(rendered).toContain(group.heading);
    }
  });

  it('renders the file’s own preamble and its own title', () => {
    tree = mountReact(<ChangelogView />);
    const rendered = text(tree.container);
    expect(tree.container.querySelector('h1')?.textContent).toBe(CHANGELOG.title);
    for (const paragraph of CHANGELOG.preamble) expect(rendered).toContain(paragraph);
  });
});

describe('each release is a section a reader can be told the name of', () => {
  it('gives every release one section, labelled by its own heading', () => {
    tree = mountReact(<ChangelogView hideTitle changelog={DATED} />);
    const { container } = tree;
    const sections = [...container.querySelectorAll('section')];
    expect(sections).toHaveLength(DATED.releases.length);

    for (const [index, section] of sections.entries()) {
      const id = section.getAttribute('aria-labelledby') ?? '';
      // Matched by scanning rather than by an id selector: `useId` returns ids containing
      // `«»`, which are legal in HTML and not legal in a CSS selector without escaping.
      const heading = [...container.querySelectorAll('[id]')].find((node) => node.id === id);
      expect(heading, `release section ${String(index)} is named by nothing`).toBeDefined();
      expect(heading?.tagName).toBe('H2');
      expect(heading?.textContent).toBe(DATED.releases[index]?.version);
    }
  });

  it('captions each release with its state rather than a bare date', () => {
    tree = mountReact(<ChangelogView hideTitle changelog={DATED} />);
    const rendered = text(tree.container);
    expect(rendered).toContain('Released 2026-09-15.');
    expect(rendered).toContain('Released 2026-01-02.');
  });

  it('names the running build on the matching release only', () => {
    tree = mountReact(<ChangelogView hideTitle changelog={DATED} appVersion="1.0.0" />);
    const marks = [...tree.container.querySelectorAll('.kh-content__lead')].filter((node) =>
      node.textContent.includes('This is the build you are running.')
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toContain('Released 2026-01-02.');
  });

  it('claims nothing about the running build when no version was supplied', () => {
    tree = mountReact(<ChangelogView hideTitle changelog={DATED} />);
    expect(text(tree.container)).not.toContain('the build you are running');
  });
});

describe('the failure states are visible rather than blank', () => {
  it('reports a changelog that parsed to nothing instead of rendering an empty page', () => {
    // An empty page here would read as "nothing has changed", which is both false and
    // exactly what a broken build produces.
    tree = mountReact(<ChangelogView hideTitle changelog={parseChangelog('')} />);
    const callouts = tree.container.querySelectorAll('.kh-content__callout--danger');
    expect(callouts).toHaveLength(1);
    expect(callouts[0]?.textContent ?? '').toContain('No releases could be read');
    expect(tree.container.querySelectorAll('section')).toHaveLength(0);
  });

  it('still renders a heading when the file supplied no title', () => {
    tree = mountReact(<ChangelogView changelog={parseChangelog('')} />);
    expect(tree.container.querySelector('h1')?.textContent).toBe(CHANGELOG_FALLBACK_TITLE);
  });
});

describe('nothing on this page originates a request or a dead control', () => {
  it('renders no anchor, from a source document that is full of links', () => {
    // Hard rule 5. `CHANGELOG.md` carries markdown links and, once there is a release, a
    // block of link-reference definitions; none of it may become something clickable.
    tree = mountReact(<ChangelogView hideTitle />);
    expect(tree.container.querySelectorAll('a')).toHaveLength(0);
    expect(text(tree.container)).not.toContain('](');
  });

  it('renders no cross-reference button, so the no-op navigate is unreachable', () => {
    tree = mountReact(<ChangelogView hideTitle />);
    expect(tree.container.querySelectorAll('.kh-content__link')).toHaveLength(0);
    expect(tree.container.querySelectorAll('button')).toHaveLength(0);
  });
});
