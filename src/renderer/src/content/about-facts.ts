// SPDX-License-Identifier: GPL-3.0-or-later

import {
  author,
  bugs,
  description,
  homepage,
  license,
  productName,
  website,
} from '../../../../package.json';
import type { ContentBlock, ContentFactRow } from './content-types.js';

/**
 * What the About page states, assembled — roadmap Phase 16.
 *
 * ## Why the page's content is a pure function
 *
 * An About page is a legal and factual claim: this is who wrote it, this is the licence it
 * is under, and this is every other person's code inside the binary. All three are things a
 * reader is entitled to rely on, and all three rot silently — a byline outlives a rename, a
 * licence line outlives a relicence, a dependency list is wrong at the next `npm install`.
 * None of that is visible in a rendered screenshot.
 *
 * So the page's *statements* live here as data, separately from the component that draws
 * them, and `about-facts.test.ts` is the guard: it re-reads `package.json`, `SECURITY.md`
 * and `LICENSE` and fails if anything stated on the page is not written down in one of them.
 * The component below it renders whatever this module returns and decides nothing.
 *
 * ## Nothing here is typed out twice
 *
 * The byline, the repository, the issue tracker and the SPDX id are **imported from
 * `package.json`**, which is the manifest of record for all four — the same reasoning that
 * makes `changelog.ts` read `CHANGELOG.md` rather than restating it, and hard rule 8 applied
 * to a byline. Vite inlines the named fields at build time and tree-shakes the rest, so
 * nothing is read from disk at runtime and nothing is fetched (hard rule 5).
 *
 * The one address that is *derived* rather than imported is the private security-advisory
 * URL: GitHub defines the path, and `SECURITY.md` is the document that publishes it. The
 * guard asserts the derived string appears verbatim in `SECURITY.md`, so if the project ever
 * moves the report route the test fails rather than the page quietly pointing people at a
 * dead form — which, for a vulnerability report, is the worst available outcome.
 *
 * ## The version does not come from here
 *
 * `package.json` carries a `version`, and reading it here would be a *second* route to a
 * number the app already reports through `window.keyhold.app.getVersion()`. It is a
 * parameter instead. See {@link AboutFactsInput}.
 *
 * ## The licence list does not come from here either
 *
 * `tools/licences.ts` derives it from `package.json` and `node_modules` using `node:fs`, so
 * the renderer cannot import it — not by preference but by construction (the renderer has no
 * Node access, and the lint config enforces that). It arrives as {@link AboutLicence} rows.
 * Every state that list can be in is rendered as something a reader can act on: absent says
 * so, empty is an alarm rather than a claim that Keyhold bundles nobody's code, and an entry
 * whose terms could not be read is repeated underneath with the check a human has to perform.
 */

// ── The project's own facts ──────────────────────────────────────────────────

/**
 * Everything the page says about the project, from the manifest that decides each one.
 *
 * `securityUrl` is the only constructed value; see the file header for why it is safe and
 * what stops it drifting.
 */
export const PROJECT = {
  name: productName,
  description,
  /** The SPDX expression, exactly as declared. Also what every source file's header says. */
  licence: license,
  authorName: author.name,
  authorUrl: author.url,
  sourceUrl: homepage,
  /** The project's own page. A separate field from `homepage`, which names the repository. */
  websiteUrl: website,
  issuesUrl: bugs.url,
  securityUrl: `${homepage}/security/advisories/new`,
} as const;

/** The page's `<h2>`. The host frame owns the `<h1>` — see `AboutView.tsx`. */
export const ABOUT_TITLE = PROJECT.name;

/** The lead under the title. The manifest's own one-line description, not a second one. */
export const ABOUT_SUMMARY = PROJECT.description;

/**
 * How an unavailable version reads.
 *
 * Deliberately a sentence rather than an empty string, a dash, or a hidden row. A blank
 * beside "Version" reads as a rendering glitch; this reads as a fact the app could not
 * establish, which is what it is.
 */
export const VERSION_UNAVAILABLE =
  'Not reported. The app could not be asked for its version, so this build cannot be identified — say so if you are filing a bug.';

// ── The third-party licence list, as it arrives ──────────────────────────────

/**
 * One third-party package, in the shape `tools/licences.ts` already produces.
 *
 * Declared here rather than imported because that module is Node-only. It is structurally
 * identical to its `LicenceEntry` on purpose, so a `readonly LicenceEntry[]` assigns to a
 * `readonly AboutLicence[]` with no cast and no adapter in between — the wiring is a
 * hand-off, not a translation, and a field added there is a compile error here rather than a
 * column that silently stops being shown.
 */
export interface AboutLicence {
  /** The npm name, scope included: `@zxcvbn-ts/core`. */
  readonly name: string;
  readonly version: string;
  /** An SPDX expression as declared, or the generator's "unknown" marker. */
  readonly licence: string;
  /** Named in Keyhold's own `dependencies`, rather than pulled in by another package. */
  readonly direct: boolean;
  /** Why the licence could not be established, phrased as the check. `null` when fine. */
  readonly problem: string | null;
}

export interface LicenceCounts {
  readonly total: number;
  readonly direct: number;
  readonly transitive: number;
  readonly unresolved: number;
}

/**
 * An entry whose terms nobody has established yet.
 *
 * Keyed off `problem` rather than off the generator's `UNKNOWN — check manually` string.
 * Both are equivalent — every entry that gets the unknown marker also gets a problem — but
 * matching the string would put a second copy of it in the renderer, where nothing would
 * fail if the generator ever reworded it. The field exists to be asked this question.
 */
export function isUnresolved(entry: AboutLicence): boolean {
  return entry.problem !== null;
}

export function licenceCounts(entries: readonly AboutLicence[]): LicenceCounts {
  const direct = entries.filter((entry) => entry.direct).length;
  return {
    total: entries.length,
    direct,
    transitive: entries.length - direct,
    unresolved: entries.filter(isUnresolved).length,
  };
}

/**
 * One row of the notice: the package and its version, then what it is licensed under.
 *
 * The version is in the term rather than the description because `name@version` is the
 * identity the generator sorts and de-duplicates by — two versions of the same package
 * genuinely both ship, and a row naming only the package would read as a duplicate.
 */
export function licenceRow(entry: AboutLicence): ContentFactRow {
  const provenance = entry.direct
    ? ''
    : ' Pulled in by another package rather than named in Keyhold’s own manifest.';
  const problem = entry.problem === null ? '' : ` What has to be checked: ${entry.problem}`;
  return {
    term: `${entry.name} ${entry.version}`,
    description: `${entry.licence}.${provenance}${problem}`,
  };
}

/** The count sentence. Phrased so it is true however the list is wired up. */
export function licenceSummarySentence(entries: readonly AboutLicence[]): string {
  const { total, direct, transitive } = licenceCounts(entries);
  const ships = total === 1 ? '1 package ships' : `${total} packages ship`;
  const split =
    transitive === 0
      ? 'each of them named in Keyhold’s own manifest'
      : `${direct} named in Keyhold’s own manifest, and ${transitive} pulled in by those`;
  return `${ships} inside Keyhold: ${split}. The list is derived from Keyhold’s own dependency manifest rather than typed out by hand, so it cannot fall behind a release.`;
}

// ── The page ─────────────────────────────────────────────────────────────────

export interface AboutFactsInput {
  /**
   * From `window.keyhold.app.getVersion()`, by way of whoever mounts the view.
   *
   * A required key that accepts `undefined` rather than an optional one: under
   * `exactOptionalPropertyTypes` that is what lets a caller forward a value it has not
   * received yet without building the object conditionally.
   */
  readonly appVersion: string | undefined;
  /** `undefined` while nothing supplies it — which the page says out loud. */
  readonly licences: readonly AboutLicence[] | undefined;
  /**
   * Whether the host can open a help article.
   *
   * The cross-reference to the About *article* is emitted only when it is true, because a
   * `link` block with no handler behind it renders a button that does nothing — worse than
   * the absence of the link, since a reader concludes the app is broken rather than that the
   * page is short.
   */
  readonly canOpenArticle: boolean;
}

function buildRows(appVersion: string | undefined): readonly ContentFactRow[] {
  return [
    { term: 'Version', description: appVersion ?? VERSION_UNAVAILABLE },
    {
      term: 'Licence',
      description: `${PROJECT.licence} — the GNU General Public License, version 3 or later. The full text ships beside the application as the file named LICENSE.`,
    },
    { term: 'Made by', description: `${PROJECT.authorName} — ${PROJECT.authorUrl}` },
  ];
}

const LINK_ROWS: readonly ContentFactRow[] = [
  {
    term: 'Website',
    description: `${PROJECT.websiteUrl} — what Keyhold is, what it costs you, and where it loses to the alternatives.`,
  },
  {
    term: 'Source code',
    description: `${PROJECT.sourceUrl} — every line of it, under the licence above.`,
  },
  {
    term: 'Report a bug',
    description: `${PROJECT.issuesUrl} — never attach a real vault file or a real password.`,
  },
  {
    term: 'Report a security problem',
    description: `${PROJECT.securityUrl} — privately, through the repository’s vulnerability reporting, rather than as a public issue.`,
  },
];

function licenceBlocks(entries: readonly AboutLicence[] | undefined): ContentBlock[] {
  if (entries === undefined) {
    return [
      {
        kind: 'not-built',
        feature: 'licence-list',
        text: 'Keyhold stands on a handful of open-source libraries, each with its own licence and its own authors. The generator that reads them out of the dependency manifest exists; nothing has handed its answer to this page yet, so the list below is absent rather than guessed at.',
      },
    ];
  }

  if (entries.length === 0) {
    // Not a formatting edge case. An empty notice reads as "Keyhold bundles nobody else's
    // code", which is false, and it is exactly what a broken generation step would produce.
    return [
      {
        kind: 'note',
        tone: 'danger',
        label: 'The licence list came back empty',
        text: 'Keyhold does bundle third-party code, so an empty list means whatever generates it failed rather than that there is nothing to declare. Do not read this page as a complete notice until it is fixed.',
      },
    ];
  }

  const blocks: ContentBlock[] = [
    { kind: 'paragraph', text: licenceSummarySentence(entries) },
    { kind: 'facts', rows: entries.map(licenceRow) },
  ];

  const unresolved = entries.filter(isUnresolved);
  if (unresolved.length > 0) {
    // Repeated rather than merely marked in the row above: an unknown licence sitting in a
    // list of ninety is an unknown licence nobody acts on.
    blocks.push(
      {
        kind: 'note',
        tone: 'warning',
        label: `Terms that could not be read (${unresolved.length})`,
        text: 'These packages ship, and their manifests did not state terms this list could record. Each one needs a person to open it and read what it is under.',
      },
      {
        kind: 'list',
        items: unresolved.map(
          (entry) => `${entry.name} ${entry.version} — ${entry.problem ?? 'reason not recorded.'}`
        ),
      }
    );
  }

  return blocks;
}

/**
 * The whole page, as blocks the existing renderer already draws.
 *
 * Blocks rather than markup so the page needs no new element, no new class and therefore no
 * new colour — and so the guard can read what the page *says* without rendering it.
 */
export function aboutBlocks(input: AboutFactsInput): readonly ContentBlock[] {
  const blocks: ContentBlock[] = [
    { kind: 'heading', text: 'This build' },
    { kind: 'facts', rows: buildRows(input.appVersion) },
  ];

  if (input.appVersion === undefined) {
    blocks.push({
      kind: 'note',
      tone: 'warning',
      label: 'This build cannot identify itself',
      text: 'The version above is missing because nothing supplied it, not because this copy has no version. A bug report from this build cannot say which release it came from, so mention that if you file one.',
    });
  }

  blocks.push(
    { kind: 'heading', text: 'Credits and links' },
    { kind: 'facts', rows: LINK_ROWS },
    {
      kind: 'note',
      tone: 'info',
      label: 'These addresses are text, not links',
      text: 'Nothing on this page opens a browser. Select an address and copy it if you want to visit it.',
    },
    { kind: 'heading', text: 'Third-party licences' },
    ...licenceBlocks(input.licences)
  );

  if (input.canOpenArticle) {
    blocks.push({
      kind: 'link',
      to: 'about',
      text: 'About Keyhold — the licence in plain English, and the honest position',
    });
  }

  return blocks;
}
