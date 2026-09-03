// SPDX-License-Identifier: GPL-3.0-or-later

import changelogSource from '../../../../CHANGELOG.md?raw';
import type { ContentBlock } from './content-types.js';

/**
 * The changelog, read from the repository's own `CHANGELOG.md` — roadmap Phase 16.
 *
 * ## Why the file, and not a second copy
 *
 * The roadmap asks for a changelog view "rendered from `CHANGELOG.md` at build time (never a
 * hand-maintained second copy)", which is hard rule 8 applied to release notes. A hand-typed
 * `changelogArticle` would be correct on the day it was written and wrong at the next
 * release, and the failure mode is the worst kind: an app that confidently tells a user what
 * it does not actually do.
 *
 * So the markdown is pulled in with Vite's `?raw` suffix. That is a **build-time** inline —
 * Rollup reads the file during the build and emits its bytes as a string literal in the
 * bundle — so nothing is read from disk at runtime, nothing is fetched (hard rule 5), and the
 * shipped app carries no second list. `tsconfig.web.json` already declares `"types":
 * ["vite/client"]`, which is what types the `*?raw` module, so no ambient declaration is
 * added here.
 *
 * ## Why this parser and not a Markdown library
 *
 * Same reasoning as `content-types.ts`: a Markdown dependency is supply-chain surface for a
 * security tool, and a renderer is not somewhere `dangerouslySetInnerHTML` should become
 * reasonable. This reads the *structure* Keep a Changelog defines — `##` is a release, `###`
 * is a group, `-` is an entry — and flattens everything else to plain text. **The output is
 * strings, never HTML**, so it feeds the existing block renderer and nothing has to be
 * sanitised.
 *
 * That is also why the block model is reused rather than extended: `releaseBlocks` projects a
 * release onto the very same `ContentBlock` union that `ContentBlockView` already draws, so
 * the changelog view needs no new markup, no new CSS and therefore no new colour.
 *
 * ## What the inline reader deliberately does not do
 *
 * It does not preserve emphasis, links or code as marks — there is nowhere to render them.
 * `**bold**` becomes bold, `` `code` `` becomes code, and `[label](url)` becomes label, the
 * URL being dropped because a changelog link would open a browser and nothing in this app may
 * originate a request. Reference-style links resolve to their label for the same reason.
 * Nesting is flattened: an indented bullet becomes an entry of the group it sits in rather
 * than being dropped, because losing a line is worse than losing its indent.
 */

// ── The shape ────────────────────────────────────────────────────────────────

/** One `###` section of a release — "Added", "Fixed", "Security", or this project's own. */
export interface ChangelogGroup {
  /** Empty when bullets appear under a release with no group heading above them. */
  readonly heading: string;
  /** One entry per bullet, wrapped continuation lines already joined. */
  readonly entries: readonly string[];
}

/** One `##` section — a released version, or the unreleased head. */
export interface ChangelogRelease {
  /** As written between the brackets: `1.2.0`, or `Unreleased`. */
  readonly version: string;
  /** Whatever followed the dash, trimmed. `null` for a release that carries no date. */
  readonly date: string | null;
  /** False for the `Unreleased` section, which is the one version that is not a version. */
  readonly released: boolean;
  /** Prose sitting under the version heading, before the first group. */
  readonly intro: readonly string[];
  readonly groups: readonly ChangelogGroup[];
}

export interface Changelog {
  /** The `#` heading. */
  readonly title: string;
  /** Prose between the title and the first release. */
  readonly preamble: readonly string[];
  /** Newest first, in file order — Keep a Changelog mandates that ordering. */
  readonly releases: readonly ChangelogRelease[];
}

// ── Inline markdown → plain text ─────────────────────────────────────────────

/**
 * Anything that must survive verbatim is lifted out before the rules run, and put back after.
 *
 * Two things need it, and both are represented in this repository's own changelog:
 *
 *  - **Code spans.** Running the emphasis rules over one mangles its contents — a glob
 *    written inside backticks loses characters to the italic rule — while stripping the
 *    backticks first and only then splitting on code strands the opening marker of a bold run
 *    that spans a code span, as this file's own "the `.keeptheme` dialogs" line does. Masking
 *    resolves both at once: emphasis sees a single inert token where the code was, so a run
 *    may cross it, and the code itself is never matched against.
 *  - **Backslash escapes.** `\*` means a literal asterisk, so it has to be settled before the
 *    italic rule looks at the line. Left until afterwards, `\*star\*` is read as emphasis and
 *    comes out as `\star\`, which is both wrong and visibly broken.
 *
 * Order matters between the two: code spans first, because a backslash inside backticks is
 * literal text and not an escape.
 *
 * The markers are private-use characters, chosen because markdown gives them no meaning and
 * because a changelog will not contain them. Any that somehow arrive in the input are dropped
 * before masking, so a crafted line cannot forge an index and pull in another span's contents.
 */
const LITERAL_MARK_OPEN = '\uE000';
const LITERAL_MARK_CLOSE = '\uE001';

/** A backtick-fenced span, matched lazily so the shortest closing run of the same length wins. */
const CODE_SPAN = /(`+)([\s\S]*?)\1/gu;

/** A backslash escape, over the punctuation CommonMark allows to be escaped. */
const ESCAPED = /\\([\\`*_{}[\]()#+\-.!>|~])/gu;

/** Applied in order, to masked text only. Links first: a link's label may be a code span. */
const INLINE_RULES: readonly (readonly [RegExp, string])[] = [
  // Images degrade to their alt text — there is no image block, and no network to load one.
  [/!\[([^\]]*)\]\([^)]*\)/gu, '$1'],
  [/\[([^\]]+)\]\([^)]*\)/gu, '$1'],
  [/\[([^\]]+)\]\[[^\]]*\]/gu, '$1'],
  [/\*\*([^*]+)\*\*/gu, '$1'],
  [/__([^_]+)__/gu, '$1'],
  [/\*([^*]+)\*/gu, '$1'],
  // Underscore emphasis only between word boundaries, so `SCREAMING_SNAKE_CASE` written
  // outside backticks does not lose its middle.
  [/(?<![\p{L}\p{N}_])_([^_]+)_(?![\p{L}\p{N}_])/gu, '$1'],
];

const PLACEHOLDER = new RegExp(`${LITERAL_MARK_OPEN}(\\d+)${LITERAL_MARK_CLOSE}`, 'gu');

const MARKERS = new RegExp(`[${LITERAL_MARK_OPEN}${LITERAL_MARK_CLOSE}]`, 'gu');

/** Inline markdown, reduced to the text a reader sees. Never returns HTML. */
export function plainText(markdown: string): string {
  const literals: string[] = [];

  const hold = (content: string): string => {
    literals.push(content);
    return `${LITERAL_MARK_OPEN}${String(literals.length - 1)}${LITERAL_MARK_CLOSE}`;
  };

  let text = markdown
    .replace(MARKERS, '')
    .replace(CODE_SPAN, (_match: string, _fence: string, content: string): string => hold(content))
    .replace(ESCAPED, (_match: string, character: string): string => hold(character));

  for (const [pattern, replacement] of INLINE_RULES) text = text.replace(pattern, replacement);

  return text
    .replace(PLACEHOLDER, (_match: string, index: string): string => literals[Number(index)] ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const HEADING = /^(#{1,6})\s+(.*)$/u;

/** Any list marker at any indent. Nesting is flattened rather than dropped. */
const BULLET = /^\s*[-*+]\s+(.*)$/u;

/**
 * A link-reference definition: `[Unreleased]: https://…/compare/v1.2.0...HEAD`.
 *
 * Keep a Changelog puts a block of these at the foot of the file, one per version. They are
 * not content — they are what makes `[1.2.0]` in a heading a link — and they carry the only
 * URLs in the whole document. Left to the ordinary paragraph path they would arrive in the
 * view as trailing bullets full of repository URLs, under the last group of the oldest
 * release. This file has none yet; it will have one the day it has a release.
 */
const LINK_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*\S/u;

/** `[1.2.0] - 2026-09-15`, the shape Keep a Changelog specifies. */
const VERSION_BRACKETED = /^\[([^\]]+)\]\s*(?:[-–—]\s*(\S.*))?$/u;

/** `1.2.0 - 2026-09-15`, for a file that omits the brackets. */
const VERSION_PLAIN = /^(\S+)(?:\s+[-–—]\s*(\S.*))?$/u;

interface MutableGroup {
  heading: string;
  entries: string[];
}

interface MutableRelease {
  version: string;
  date: string | null;
  released: boolean;
  intro: string[];
  groups: MutableGroup[];
}

/**
 * A `##` heading, read as a version and an optional date.
 *
 * The bracketed form is tried first because it is unambiguous: the version is whatever sits
 * inside the brackets, so a pre-release like `1.0.0-rc.1` cannot be mistaken for a version
 * followed by a dash and a date. The plain form falls back to "the first run of non-space
 * characters", which reaches the same answer for the same input.
 */
function parseVersionHeading(heading: string): { version: string; date: string | null } {
  const match = VERSION_BRACKETED.exec(heading) ?? VERSION_PLAIN.exec(heading);
  if (match === null) return { version: heading.trim(), date: null };

  const version = (match[1] ?? '').trim();
  const date = match[2]?.trim();
  return { version, date: date === undefined || date === '' ? null : date };
}

/**
 * Markdown in, structure out.
 *
 * Exported as a pure function of its input, separately from the parsed constant below, so the
 * guards can drive it with fixtures — a parser that can only be tested against the one file
 * it ships with is a parser whose date handling is untested until the first release.
 */
export function parseChangelog(markdown: string): Changelog {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');

  let title = '';
  const preamble: string[] = [];
  const releases: MutableRelease[] = [];

  let release: MutableRelease | null = null;
  let group: MutableGroup | null = null;
  let paragraph: string[] = [];
  let entry: string[] | null = null;

  /** The group open right now, creating an unheaded one if bullets arrived without a `###`. */
  const currentGroup = (owner: MutableRelease): MutableGroup => {
    if (group !== null) return group;
    group = { heading: '', entries: [] };
    owner.groups.push(group);
    return group;
  };

  const flushEntry = (): void => {
    if (entry === null) return;
    const text = plainText(entry.join(' '));
    entry = null;
    if (text === '' || release === null) return;
    currentGroup(release).entries.push(text);
  };

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const text = plainText(paragraph.join(' '));
    paragraph = [];
    if (text === '') return;
    if (release === null) {
      preamble.push(text);
      return;
    }
    // Prose under a group heading is kept as an entry of that group. It is not a bullet, but
    // dropping a line because it was not one is how a changelog view starts lying.
    if (group === null) release.intro.push(text);
    else group.entries.push(text);
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim() === '') {
      flushEntry();
      flushParagraph();
      continue;
    }

    if (LINK_DEFINITION.test(line)) {
      flushEntry();
      flushParagraph();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushEntry();
      flushParagraph();

      const level = (heading[1] ?? '').length;
      const text = plainText(heading[2] ?? '');

      if (level === 1) {
        if (title === '') title = text;
        continue;
      }

      if (level === 2) {
        const { version, date } = parseVersionHeading(text);
        release = {
          version,
          date,
          released: version.toLowerCase() !== 'unreleased',
          intro: [],
          groups: [],
        };
        releases.push(release);
        group = null;
        continue;
      }

      // A `###` before any release has nothing to belong to; Keep a Changelog does not
      // produce one, and inventing a release to hold it would be worse than ignoring it.
      if (release !== null) {
        group = { heading: text, entries: [] };
        release.groups.push(group);
      }
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      flushEntry();
      flushParagraph();
      entry = [bullet[1] ?? ''];
      continue;
    }

    // Not blank, not a heading, not a bullet: a wrapped continuation of whichever of the two
    // is open. Markdown allows a continuation to be unindented, so indentation is not the test.
    if (entry !== null) entry.push(line.trim());
    else paragraph.push(line.trim());
  }

  flushEntry();
  flushParagraph();

  return { title, preamble, releases };
}

// ── The parsed file ──────────────────────────────────────────────────────────

/** The raw markdown the bundle was built from. Exported so a guard can count against it. */
export const CHANGELOG_SOURCE: string = changelogSource;

/** `CHANGELOG.md`, parsed once at module load from a string inlined at build time. */
export const CHANGELOG: Changelog = parseChangelog(CHANGELOG_SOURCE);

/** The unreleased head, when there is one. What a pre-release build has to show. */
export function unreleased(changelog: Changelog = CHANGELOG): ChangelogRelease | null {
  return changelog.releases.find((entry) => !entry.released) ?? null;
}

// ── Projection onto the existing block renderer ──────────────────────────────

/**
 * One release as blocks `ContentBlockView` already knows how to draw.
 *
 * The version and its date are **not** included: they are the release's own heading, which
 * sits at `<h2>` above the block model's single `<h3>` level, so the view renders them and
 * heading order stays correct by construction — the same property `content-types.ts` protects.
 */
export function releaseBlocks(release: ChangelogRelease): readonly ContentBlock[] {
  const blocks: ContentBlock[] = release.intro.map((text) => ({ kind: 'paragraph', text }));

  for (const group of release.groups) {
    if (group.heading !== '') blocks.push({ kind: 'heading', text: group.heading });
    if (group.entries.length > 0) blocks.push({ kind: 'list', items: group.entries });
  }

  return blocks;
}
