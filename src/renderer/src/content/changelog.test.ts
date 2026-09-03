// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  CHANGELOG,
  CHANGELOG_FALLBACK_TITLE,
  CHANGELOG_SOURCE,
  NO_RELEASES,
  changelogTitle,
  parseChangelog,
  plainText,
  preambleBlocks,
  releaseBlocks,
  releaseCaption,
  unreleased,
  type ChangelogRelease,
} from './changelog.js';

/**
 * Guards for the changelog parser.
 *
 * The whole point of reading `CHANGELOG.md` rather than retyping it is that the app cannot
 * drift from the repository. That guarantee is only as good as the parser: a reader that
 * silently drops a bullet, swallows a group, or leaves `**` on the screen turns "generated
 * from the source of truth" into "wrong, with extra confidence". None of those failures throw,
 * and nobody reads the changelog view often enough to notice, so they are asserted here.
 *
 * Two kinds of test, on purpose:
 *
 *   - **Fixture-driven**, for shapes this repository's changelog does not contain yet — a
 *     dated release, a pre-release version, a nested bullet, CRLF. Waiting for the first
 *     release to find out whether date parsing works is not a plan.
 *   - **Over the real file**, for the properties that must hold of what actually ships. The
 *     entry count is checked against a bullet count taken independently from the raw source,
 *     which is what makes "nothing was dropped" a real assertion rather than a hope.
 *
 * Fault injections performed against this file, each confirmed to fail on the exact defect it
 * claims to catch — the output of every one is recorded in the task report:
 *
 *   1. `VERSION_BRACKETED` made to stop capturing the date → `reads the version and the date
 *      from a bracketed heading` + 1 more fail.
 *   2. A wrapped continuation line dropped instead of appended to the open bullet → `joins a
 *      wrapped bullet back into one entry` + 2 more fail.
 *   3. The bullet regex anchored to column zero (`^\s*` → `^`), so an indented bullet reads as
 *      a continuation → `flattens an indented bullet into its own entry` fails.
 *   4. Code-span masking replaced by plain backtick stripping, so the emphasis rules run over
 *      code → `keeps a code span's contents out of the emphasis rules` fails.
 *   5. The `**` rule dropped from `INLINE_RULES` → `strips inline markdown to plain text` + 1
 *      more fail. **This one is why `no entry still carries markdown syntax` rejects any
 *      asterisk rather than only a surviving `**` pair:** without the bold rule, the italic
 *      rule eats the inner pair and leaves a single star at each end, so the `**`-only check
 *      passed the injection. The guard was strengthened until it did not.
 *   6. The version heading split on the first dash → `keeps a pre-release version whole` + 2
 *      more fail.
 *   7. The flush after the parse loop removed → `keeps the last entry of a file that ends
 *      without a trailing newline` fails. That test was added *for* this injection: without
 *      it the defect failed nothing, because every file here ends with a newline.
 *   8. Backslash-escape masking removed → `strips inline markdown to plain text` fails. This
 *      was a real defect, found by the test before it was a fault injection: `\*star\*` came
 *      out as `\star\` while the escape rule sat after the emphasis rules instead of before.
 *   9. The link-reference-definition skip removed → `drops the link-reference definitions Keep
 *      a Changelog puts at the foot of the file` fails.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DATED = [
  '# Changelog',
  '',
  'Everything worth knowing.',
  '',
  '## [1.2.0] - 2026-09-15',
  '',
  'The release that fixed the thing.',
  '',
  '### Added',
  '',
  '- A first entry that runs past the margin and is',
  '  wrapped onto a second line by the formatter.',
  '- A second entry.',
  '',
  '### Fixed',
  '',
  '- Something broken.',
  '',
  '## [1.0.0-rc.1] - 2026-01-02',
  '',
  '### Added',
  '',
  '- The beginning.',
  '',
].join('\n');

function onlyRelease(markdown: string): ChangelogRelease {
  const [release] = parseChangelog(markdown).releases;
  if (release === undefined) throw new Error('the fixture parsed to no releases at all');
  return release;
}

// ── The version heading ──────────────────────────────────────────────────────

describe('the version heading', () => {
  it('reads the version and the date from a bracketed heading', () => {
    const release = onlyRelease(DATED);
    expect(release.version).toBe('1.2.0');
    expect(release.date).toBe('2026-09-15');
    expect(release.released).toBe(true);
  });

  it('keeps a pre-release version whole rather than splitting it at its own dash', () => {
    // `1.0.0-rc.1 - 2026-01-02` has two dashes and only the second one separates the date.
    // Splitting on the first would ship a changelog announcing version "1.0.0".
    const release = parseChangelog(DATED).releases[1];
    expect(release?.version).toBe('1.0.0-rc.1');
    expect(release?.date).toBe('2026-01-02');
  });

  it('reads an unbracketed heading, and an em-dashed date separator', () => {
    expect(onlyRelease('## 2.0.0 — 2026-10-01\n').version).toBe('2.0.0');
    expect(onlyRelease('## 2.0.0 — 2026-10-01\n').date).toBe('2026-10-01');
  });

  it('marks the unreleased head as unreleased and dateless', () => {
    const release = onlyRelease('## [Unreleased]\n\n### Added\n\n- Something.\n');
    expect(release.version).toBe('Unreleased');
    expect(release.released).toBe(false);
    expect(release.date).toBeNull();
    expect(unreleased(parseChangelog('## [Unreleased]\n'))?.version).toBe('Unreleased');
  });

  it('keeps releases in file order, newest first', () => {
    expect(parseChangelog(DATED).releases.map((release) => release.version)).toEqual([
      '1.2.0',
      '1.0.0-rc.1',
    ]);
  });
});

// ── Structure ────────────────────────────────────────────────────────────────

describe('structure', () => {
  it('reads the title and the preamble', () => {
    const changelog = parseChangelog(DATED);
    expect(changelog.title).toBe('Changelog');
    expect(changelog.preamble).toEqual(['Everything worth knowing.']);
  });

  it('keeps prose under a version heading as that release’s intro', () => {
    expect(onlyRelease(DATED).intro).toEqual(['The release that fixed the thing.']);
  });

  it('groups entries under the heading above them', () => {
    expect(onlyRelease(DATED).groups.map((group) => group.heading)).toEqual(['Added', 'Fixed']);
    expect(onlyRelease(DATED).groups[1]?.entries).toEqual(['Something broken.']);
  });

  it('joins a wrapped bullet back into one entry', () => {
    // The formatter wraps every long line in this repository's changelog, so a parser that
    // takes one line per entry loses the second half of nearly everything it reads.
    expect(onlyRelease(DATED).groups[0]?.entries).toEqual([
      'A first entry that runs past the margin and is wrapped onto a second line by the formatter.',
      'A second entry.',
    ]);
  });

  it('flattens an indented bullet into its own entry rather than folding it into the one above', () => {
    const release = onlyRelease('## [1.0.0]\n\n### Added\n\n- Parent.\n  - Child.\n');
    expect(release.groups[0]?.entries).toEqual(['Parent.', 'Child.']);
  });

  it('keeps bullets that arrive with no group heading, in an unheaded group', () => {
    const release = onlyRelease('## [1.0.0]\n\n- Loose.\n');
    expect(release.groups).toEqual([{ heading: '', entries: ['Loose.'] }]);
  });

  it('reads a file written with CRLF line endings', () => {
    const release = onlyRelease(DATED.replace(/\n/gu, '\r\n'));
    expect(release.version).toBe('1.2.0');
    expect(release.groups[0]?.entries[1]).toBe('A second entry.');
  });

  it('keeps the last entry of a file that ends without a trailing newline', () => {
    // A bullet is only complete when something ends it, and at the end of a file nothing
    // does. Every editor here writes a trailing newline, so this defect would never show up
    // against the repository's own changelog — it would wait for the one file that lacks one.
    const release = onlyRelease('## [1.0.0]\n\n### Added\n\n- First.\n- Last, unterminated.');
    expect(release.groups[0]?.entries).toEqual(['First.', 'Last, unterminated.']);
  });

  it('drops the link-reference definitions Keep a Changelog puts at the foot of the file', () => {
    // Not content: they are what makes `[1.2.0]` in a heading a link, and they hold the only
    // URLs in the document. Read as prose they would arrive in the view as trailing bullets
    // full of repository URLs. This repository's changelog has none yet — it will have one on
    // the day it has a release, which is exactly when nobody will be looking for this.
    const release = onlyRelease(
      [
        '## [1.0.0] - 2026-01-02',
        '',
        '### Added',
        '',
        '- The beginning.',
        '',
        '[unreleased]: https://example.invalid/compare/v1.0.0...HEAD',
        '[1.0.0]: https://example.invalid/releases/tag/v1.0.0',
        '',
      ].join('\n')
    );
    expect(release.groups).toEqual([{ heading: 'Added', entries: ['The beginning.'] }]);
    expect(JSON.stringify(release)).not.toContain('example.invalid');
  });

  it('returns an empty changelog for empty input rather than throwing', () => {
    expect(parseChangelog('')).toEqual({ title: '', preamble: [], releases: [] });
  });
});

// ── Inline markdown ──────────────────────────────────────────────────────────

describe('inline markdown', () => {
  it('strips inline markdown to plain text', () => {
    expect(plainText('**bold** and *italic* and `code`')).toBe('bold and italic and code');
    expect(plainText('[the label](https://example.invalid/page)')).toBe('the label');
    expect(plainText('[the label][ref]')).toBe('the label');
    expect(plainText('![alt text](image.png)')).toBe('alt text');
    expect(plainText('__strong__ and _emphasis_')).toBe('strong and emphasis');
    expect(plainText('an escaped \\*star\\*')).toBe('an escaped *star*');
  });

  it('resolves a bold run that spans a code span', () => {
    // Real line shape from this repository's changelog. Segmenting on code spans strands the
    // opening `**` in one segment and the closing `**` in another, leaving both on screen.
    expect(plainText('**TOTP, the `.keeptheme` dialogs, and the tour** — each built')).toBe(
      'TOTP, the .keeptheme dialogs, and the tour — each built'
    );
  });

  it("keeps a code span's contents out of the emphasis rules", () => {
    expect(plainText('`SCREAMING_SNAKE_CASE`')).toBe('SCREAMING_SNAKE_CASE');
    expect(plainText('`a *starred* thing`')).toBe('a *starred* thing');
    expect(plainText('`**/*.keep`')).toBe('**/*.keep');
  });

  it('leaves an identifier with underscores alone outside backticks', () => {
    expect(plainText('CUSTOM_FIELD_TYPES is a registry')).toBe('CUSTOM_FIELD_TYPES is a registry');
  });

  it('takes the label from a link whose label is itself code', () => {
    expect(plainText('[`docs/12-Roadmap/00-Master-Checklist.md`](./docs/12-Roadmap/x.md)')).toBe(
      'docs/12-Roadmap/00-Master-Checklist.md'
    );
  });

  it('leaves no marker character in the output, and cannot be tricked into borrowing one', () => {
    // The masking placeholders are private-use characters. Input carrying them is stripped
    // before masking, so a hand-written line cannot forge an index and pull in another span.
    const forged = plainText('\uE0000\uE001 then `real code`');
    expect(forged).toBe('0 then real code');
    expect(forged).not.toMatch(/[\uE000\uE001]/u);
  });
});

// ── The real file ────────────────────────────────────────────────────────────

const releases = CHANGELOG.releases;
const allEntries = releases.flatMap((release) => release.groups.flatMap((group) => group.entries));

describe("the repository's own CHANGELOG.md", () => {
  it('is inlined at build time and parsed into something substantial', () => {
    // Non-vacuity. Every assertion below passes perfectly against an empty parse, which is
    // exactly what a broken `?raw` import or a regex that matches nothing would produce.
    expect(CHANGELOG_SOURCE.length).toBeGreaterThan(2000);
    expect(CHANGELOG.title).toBe('Changelog');
    expect(CHANGELOG.preamble.length).toBeGreaterThan(0);
    expect(releases.length).toBeGreaterThan(0);
    expect(allEntries.length).toBeGreaterThan(25);
  });

  it('every bullet in the file becomes exactly one entry', () => {
    // Counted independently of the parser, off the same string the parser was handed. This is
    // the assertion that makes "nothing was silently dropped" checkable: a swallowed section,
    // a lost last entry, or a continuation line mistaken for a bullet all move this number.
    const bullets = CHANGELOG_SOURCE.split(/\r\n|\r|\n/u).filter((line) =>
      /^\s*[-*+]\s+\S/u.test(line)
    );
    expect(allEntries).toHaveLength(bullets.length);
  });

  it('every group carries a heading and at least one entry', () => {
    for (const release of releases) {
      for (const group of release.groups) {
        expect(group.heading, `${release.version} has an unheaded group`).not.toBe('');
        expect(group.entries.length, `${release.version} → ${group.heading}`).toBeGreaterThan(0);
      }
    }
  });

  it('every entry ends as a whole sentence, so no continuation was left behind', () => {
    for (const entry of allEntries) {
      expect(entry.length, entry).toBeGreaterThan(20);
      expect(entry, 'an entry ends mid-line').toMatch(/[.!?:)»”"'`\w]$/u);
    }
  });

  it('no entry still carries markdown syntax', () => {
    for (const entry of allEntries) {
      // Any asterisk at all, not just a surviving `**` pair. Dropping the bold rule leaves a
      // *single* star at each end rather than two, because the italic rule then eats the
      // inner pair \u2014 a defect that a `**`-only check waves straight through, which is what a
      // fault injection against this file actually demonstrated.
      expect(entry, 'an emphasis marker survived').not.toMatch(/[*]/u);
      expect(entry, 'a code fence survived').not.toContain('`');
      expect(entry, 'a link survived unresolved').not.toMatch(/\]\(/u);
      expect(entry, 'a marker character leaked into the output').not.toMatch(/[\uE000\uE001]/u);
    }
  });

  it('entries are unique within a group, because the renderer keys list items by their text', () => {
    for (const release of releases) {
      for (const group of release.groups) {
        expect(new Set(group.entries).size, `${release.version} → ${group.heading}`).toBe(
          group.entries.length
        );
      }
    }
  });

  it('every release is either the unreleased head with no date, or carries an ISO date', () => {
    for (const release of releases) {
      if (release.released) {
        expect(release.date, `${release.version} has no usable date`).toMatch(
          /^\d{4}-\d{2}-\d{2}$/u
        );
      } else {
        expect(release.date, 'the unreleased head must not claim a date').toBeNull();
      }
    }
  });
});

// ── The projection onto the block renderer ───────────────────────────────────

describe('projection onto the block model', () => {
  const release = onlyRelease(DATED);
  const blocks = releaseBlocks(release);

  it('emits only blocks the existing viewer can already draw', () => {
    // A kind the viewer does not handle would be a blank space on the page rather than an
    // error, so the set is asserted rather than assumed.
    for (const block of blocks) expect(['paragraph', 'heading', 'list']).toContain(block.kind);
  });

  it('carries every intro paragraph, every group heading and every entry', () => {
    expect(blocks.filter((block) => block.kind === 'paragraph').map((block) => block.text)).toEqual(
      [...release.intro]
    );
    expect(blocks.filter((block) => block.kind === 'heading').map((block) => block.text)).toEqual(
      release.groups.map((group) => group.heading)
    );
    expect(
      blocks.filter((block) => block.kind === 'list').flatMap((block) => [...block.items])
    ).toEqual(release.groups.flatMap((group) => [...group.entries]));
  });

  it('omits the heading block for an unheaded group rather than drawing an empty one', () => {
    const loose = releaseBlocks(onlyRelease('## [1.0.0]\n\n- Loose.\n'));
    expect(loose.map((block) => block.kind)).toEqual(['list']);
  });

  it('leaves the version and its date to the view, keeping one heading level in the blocks', () => {
    const headings = blocks.filter((block) => block.kind === 'heading').map((block) => block.text);
    expect(headings).not.toContain(release.version);
    expect(headings.join(' ')).not.toContain('2026-09-15');
  });

  it('projects the real file without losing an entry', () => {
    const projected = releases.flatMap((entry) =>
      releaseBlocks(entry)
        .filter((block) => block.kind === 'list')
        .flatMap((block) => [...block.items])
    );
    expect(projected).toEqual(allEntries);
  });
});

// ── The copy the page is built out of ────────────────────────────────────────

/**
 * The page's own strings are checked here rather than in `ChangelogView.test.tsx` for the
 * reason `about-facts.test.ts` gives: whether the page states something true should be
 * answerable without mounting React, and the view's guard is then free to be only about what
 * a rendered page can get wrong independently of its content.
 */
describe('what the page says around the releases', () => {
  it('takes its title from the file rather than restating one', () => {
    expect(changelogTitle(CHANGELOG)).toBe(CHANGELOG.title);
    expect(changelogTitle(parseChangelog('# Release notes\n'))).toBe('Release notes');
  });

  it('falls back to a title when the file supplied none', () => {
    // The state a broken `?raw` import produces. An empty `<h1>` reads as a rendering fault
    // rather than as the build fault it is, and the body's callout is what explains it.
    expect(changelogTitle(parseChangelog(''))).toBe(CHANGELOG_FALLBACK_TITLE);
  });

  it('renders the file’s own preamble rather than a paraphrase of it', () => {
    expect(preambleBlocks(CHANGELOG).map((block) => block.kind === 'paragraph' && block.text)) //
      .toEqual([...CHANGELOG.preamble]);
    expect(preambleBlocks(parseChangelog('# X\n'))).toEqual([]);
  });

  describe('the caption under a release heading', () => {
    const dated = onlyRelease('## [1.2.0] - 2026-09-15\n');
    const undated = onlyRelease('## [1.2.0]\n');
    const head = onlyRelease('## [Unreleased]\n');

    it('says when a release was made, in a sentence rather than as a bare date', () => {
      // A date alone under a version number does not say what happened on it.
      expect(releaseCaption(dated)).toBe('Released 2026-09-15.');
      expect(releaseCaption(dated)).toContain(dated.date ?? '');
    });

    it('says a dateless release has no date rather than rendering an empty line', () => {
      expect(releaseCaption(undated)).toBe('No release date is recorded for this version.');
    });

    it('marks the unreleased head as unreleased', () => {
      expect(releaseCaption(head)).toBe('Not released yet.');
    });

    it('is never empty, for any release in the real file', () => {
      // The unreleased head is the only section a pre-release build has, and it is the one
      // with no date — so "print the date" would leave this page's only caption blank.
      for (const release of releases) expect(releaseCaption(release).length).toBeGreaterThan(0);
    });

    it('names the running build on the release it matches, and appends rather than replaces', () => {
      const caption = releaseCaption(dated, '1.2.0');
      expect(caption).toContain('This is the build you are running.');
      expect(caption).toContain('Released 2026-09-15.');
    });

    it('claims nothing when the running version matches no release, or is unknown', () => {
      // Exact equality only. A near-match marked as "you are running this" is worse than no
      // marker at all, because a reader acts on it.
      expect(releaseCaption(dated, '1.2')).not.toContain('running');
      expect(releaseCaption(dated, 'v1.2.0')).not.toContain('running');
      expect(releaseCaption(dated, '1.2.0-rc.1')).not.toContain('running');
      expect(releaseCaption(dated)).not.toContain('running');
    });
  });

  it('has an empty state that reports a build fault rather than implying nothing changed', () => {
    expect(parseChangelog('').releases).toHaveLength(0);
    expect(NO_RELEASES.kind).toBe('note');
    // Not `info`. An empty changelog cannot happen to a correctly built copy, so the page
    // has to say so loudly — the same call `about-facts.ts` makes about an empty licence list.
    expect(NO_RELEASES).toMatchObject({ kind: 'note', tone: 'danger' });
  });
});
