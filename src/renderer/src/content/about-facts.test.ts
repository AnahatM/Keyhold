// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import licenceText from '../../../../LICENSE?raw';
import manifestText from '../../../../package.json?raw';
import securityPolicy from '../../../../SECURITY.md?raw';
import {
  PROJECT,
  VERSION_UNAVAILABLE,
  aboutBlocks,
  licenceCounts,
  licenceSummarySentence,
  type AboutLicence,
} from './about-facts.js';
import { articleProse } from './content-registry.js';
import type { ContentArticle, ContentBlock } from './content-types.js';

/**
 * The guard on the About page's claims.
 *
 * An About page is the one screen whose content is a factual and legal assertion — this is
 * who wrote it, this is the licence, this is everyone else's code inside the binary — and all
 * three rot without anything looking wrong. So none of them are asserted against a literal
 * typed in this file. They are asserted against `package.json`, `SECURITY.md` and `LICENSE`,
 * read at build time through Vite's `?raw`, which is the same trade `changelog.ts` makes:
 * the repository's own documents are the expected value, so a rename, a relicence or a moved
 * report route fails here instead of shipping a page that confidently misleads a reader.
 *
 * The URL sweep is the one worth understanding. It does not check a list of addresses; it
 * pulls **every** `http(s)` string out of the assembled page and demands each one appear in
 * a repository document. That is what makes an *invented* address — the failure mode of
 * writing an About page from memory — a test failure rather than a plausible-looking link
 * pointing at nothing.
 *
 * Fault injections performed against these guards, all caught and all reverted. Counts are
 * the failures in this file:
 *
 *   | Injection                                                             | Result |
 *   |-----------------------------------------------------------------------|--------|
 *   | a plausible `https://keyhold.app` added to the credits rows            | 1 failed — `https://keyhold.app is stated on the About page but written down nowhere` |
 *   | `securityUrl` built as `/security/policy` instead of `/advisories/new` | 2 failed — SECURITY.md no longer contains it, and the sweep |
 *   | the licence row reworded to "version 2 or later"                       | 1 failed — `expected '…' to contain 'version 3 or later'`, the expansion being derived from LICENSE's own heading |
 *   | `buildRows` falls back to `''` instead of `VERSION_UNAVAILABLE`        | 1 failed — `expected 'This build\nVersion\n\nLicence…' to contain 'Not reported. …'` |
 *   | `licenceRow` drops the version from its term                           | 1 failed — `@zxcvbn-ts/core is listed without its version` |
 *   | `licenceBlocks` returns `[]` when the list is absent                   | 1 failed — `an absent licence list must be marked, not silently omitted` |
 *   | the empty-list branch removed                                          | 1 failed — `an empty licence list must raise an alarm, not render as a notice` |
 *   | `isUnresolved` inverted to `problem === null`                          | 3 failed — the counts, the vanished problem text, and a clean list growing a warning |
 *   | the `link` block emitted unconditionally                               | 1 failed — `a link block with no handler behind it renders a button that does nothing` |
 *
 * The first attempt at that table was worthless: the harness ran `vitest --reporter=basic`,
 * which does not exist in Vitest 4, so every run died at startup and every injection looked
 * "caught". An injection that fails for the wrong reason is not a verified guard. Re-run
 * against real output before trusting a row here.
 */

// ── Reading the page ─────────────────────────────────────────────────────────

/**
 * Every human-readable string the page states, in reading order.
 *
 * `articleProse` rather than a second extractor: the registry already knows how to read
 * every block kind, and a kind added there becomes visible to this guard for free. A private
 * copy here would be the thing that stops covering a kind while still passing.
 */
function prose(blocks: readonly ContentBlock[]): string {
  const asArticle: ContentArticle = {
    id: 'about',
    title: '',
    summary: '',
    keywords: [],
    body: blocks,
    related: [],
  };
  return articleProse(asArticle).join('\n');
}

function factRows(
  blocks: readonly ContentBlock[]
): readonly { term: string; description: string }[] {
  return blocks.flatMap((block) =>
    block.kind === 'facts'
      ? block.rows.map((row) => ({ term: row.term, description: row.description }))
      : []
  );
}

const manifest = JSON.parse(manifestText) as {
  productName: string;
  description: string;
  license: string;
  author: { name: string; url: string };
  homepage: string;
  bugs: { url: string };
};

const entry = (over: Partial<AboutLicence> = {}): AboutLicence => ({
  name: 'react',
  version: '19.2.8',
  licence: 'MIT',
  direct: true,
  problem: null,
  ...over,
});

const page = (over: Partial<Parameters<typeof aboutBlocks>[0]> = {}): readonly ContentBlock[] =>
  aboutBlocks({
    appVersion: '0.1.0',
    licences: [entry()],
    canOpenArticle: false,
    ...over,
  });

// ── The project's own facts ──────────────────────────────────────────────────

describe('every fact is the manifest of record, not a copy of it', () => {
  it('takes the byline, the addresses and the SPDX id from package.json', () => {
    expect(PROJECT.name).toBe(manifest.productName);
    expect(PROJECT.description).toBe(manifest.description);
    expect(PROJECT.licence).toBe(manifest.license);
    expect(PROJECT.authorName).toBe(manifest.author.name);
    expect(PROJECT.authorUrl).toBe(manifest.author.url);
    expect(PROJECT.sourceUrl).toBe(manifest.homepage);
    expect(PROJECT.issuesUrl).toBe(manifest.bugs.url);
  });

  it('points a vulnerability report at the route SECURITY.md publishes', () => {
    // The one constructed address. If the project ever moves its report route, this fails
    // rather than the page sending someone with a vulnerability to a dead form.
    expect(securityPolicy).toContain(PROJECT.securityUrl);
  });

  it('invents no address anywhere on the page', () => {
    const stated = [...prose(page()).matchAll(/https?:\/\/[^\s]+/gu)].map((match) =>
      match[0].replace(/[.,;:’')\]]+$/u, '')
    );

    expect(stated.length).toBeGreaterThan(0);
    for (const url of stated) {
      const written = manifestText.includes(url) || securityPolicy.includes(url);
      expect(written, `${url} is stated on the About page but written down nowhere`).toBe(true);
    }
  });
});

describe('the licence statement tracks the licence actually shipped', () => {
  it('names the SPDX expression every source file already carries', () => {
    expect(PROJECT.licence).toBe('GPL-3.0-or-later');
    expect(prose(page())).toContain(PROJECT.licence);
  });

  it('expands it to the version LICENSE itself declares', () => {
    expect(licenceText).toContain('GNU GENERAL PUBLIC LICENSE');
    const declared = /Version (\d+)/u.exec(licenceText);
    expect(declared).not.toBeNull();

    // Derived from the shipped licence text rather than typed here: relicensing the project
    // has to move this sentence, and forgetting is a failure rather than a stale paragraph.
    expect(prose(page())).toContain(`version ${declared?.[1] ?? ''} or later`);
  });

  it('says where a reader can find the full text', () => {
    expect(prose(page())).toContain('LICENSE');
  });
});

// ── The version ──────────────────────────────────────────────────────────────

describe('the version', () => {
  it('is stated verbatim when the app reports one', () => {
    const text = prose(page({ appVersion: '1.4.2-beta.3' }));
    expect(text).toContain('1.4.2-beta.3');
    expect(text).not.toContain(VERSION_UNAVAILABLE);
  });

  it('is a marked gap when nothing supplies one, never a blank', () => {
    const blocks = page({ appVersion: undefined });
    const text = prose(blocks);

    expect(text).toContain(VERSION_UNAVAILABLE);
    expect(text).toContain('cannot identify itself');

    for (const row of factRows(blocks)) {
      expect(row.description.trim(), `the "${row.term}" row rendered blank`).not.toBe('');
    }
  });

  it('does not warn about a version it was given', () => {
    expect(prose(page({ appVersion: '0.1.0' }))).not.toContain('cannot identify itself');
  });
});

// ── The third-party notice ───────────────────────────────────────────────────

describe('the third-party licence list', () => {
  const shipped: readonly AboutLicence[] = [
    entry({ name: '@zxcvbn-ts/core', version: '4.2.0' }),
    entry({ name: 'scheduler', version: '0.27.0', direct: false }),
    entry({ name: 'react-dom', version: '19.2.8' }),
  ];

  it('says so when nothing has supplied it', () => {
    const blocks = page({ licences: undefined });
    const marked = blocks.some(
      (block) => block.kind === 'not-built' && block.feature === 'licence-list'
    );
    expect(marked, 'an absent licence list must be marked, not silently omitted').toBe(true);
  });

  it('drops the unbuilt marker once a list arrives', () => {
    const stale = page({ licences: shipped }).some((block) => block.kind === 'not-built');
    expect(stale, 'the list is present, so nothing may still call it unbuilt').toBe(false);
  });

  it('states every package, its version and its terms', () => {
    const text = prose(page({ licences: shipped }));
    for (const item of shipped) {
      expect(text, `${item.name} is missing from the notice`).toContain(item.name);
      expect(text, `${item.name} is listed without its version`).toContain(item.version);
      expect(text, `${item.name} is listed without its licence`).toContain(item.licence);
    }
  });

  it('counts what ships, and separates what Keyhold asked for from what came with it', () => {
    expect(licenceCounts(shipped)).toEqual({ total: 3, direct: 2, transitive: 1, unresolved: 0 });
    const sentence = licenceSummarySentence(shipped);
    expect(sentence).toContain('3 packages ship');
    expect(sentence).toContain('2 named');
    expect(sentence).toContain('1 pulled in');
  });

  it('treats an empty list as a fault, never as "nothing to declare"', () => {
    const blocks = page({ licences: [] });
    const text = prose(blocks);

    const alarmed = blocks.some((block) => block.kind === 'note' && block.tone === 'danger');
    expect(alarmed, 'an empty licence list must raise an alarm, not render as a notice').toBe(true);
    expect(text).not.toMatch(/\b0 packages?\b/u);
    expect(text).toContain('does bundle third-party code');
  });

  it('repeats the packages whose terms nobody could read, with the check they need', () => {
    const problem = 'the manifest declares no "license" field.';
    const blocks = page({ licences: [...shipped, entry({ name: 'mystery', problem })] });
    const text = prose(blocks);

    expect(licenceCounts([entry({ problem })]).unresolved).toBe(1);
    expect(text).toContain('Terms that could not be read (1)');
    expect(text).toContain(problem);
  });

  it('adds no warning to a list whose terms are all known', () => {
    expect(prose(page({ licences: shipped }))).not.toContain('Terms that could not be read');
  });
});

// ── The cross-reference ──────────────────────────────────────────────────────

describe('the cross-reference to the About article', () => {
  it('is absent when the host cannot open one', () => {
    const dead = page({ canOpenArticle: false }).some((block) => block.kind === 'link');
    expect(dead, 'a link block with no handler behind it renders a button that does nothing').toBe(
      false
    );
  });

  it('is a single link to the about article when it can', () => {
    const links = page({ canOpenArticle: true }).filter((block) => block.kind === 'link');
    expect(links).toHaveLength(1);
    expect(links[0]?.kind === 'link' ? links[0].to : null).toBe('about');
  });
});
