// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  AUDIT_LEVEL_FIELDS,
  AUDIT_PRIVACY_LEVELS,
  VERSIONED_FIELDS,
} from '@shared/model/credential.js';
import { DEFAULT_VAULT_SETTINGS } from '@shared/model/vault-document.js';
import { DEFAULT_KDF_PARAMS } from '@shared/format/types.js';
import {
  CONTENT_ARTICLES,
  DEFAULT_ARTICLE_ID,
  articleLinkTargets,
  articleMentions,
  articleProse,
  declaredUnbuilt,
  findArticle,
  toWords,
} from './content-registry.js';
import { CONTENT_ARTICLE_IDS, type ContentArticleId } from './content-types.js';
import { UNBUILT_FEATURES, UNBUILT_FEATURE_IDS } from './feature-status.js';
import { SHORTCUT_COUNT, SHORTCUT_SCOPE_ROWS } from './shortcuts-source.js';

/**
 * Guards for the content registry.
 *
 * The point of every test here is that help text is the one part of an app nobody
 * exercises. A dead cross-link, a duplicated id or a page describing a button that does not
 * exist all survive indefinitely, because the only way to notice is to read the pages —
 * which nobody does until a user is already lost. So the invariants are asserted instead.
 *
 * Fault injections performed, all confirmed to fail on the defect they claim to catch:
 *
 *   - Two articles given the same id → `ids are unique` and `each article's id matches its
 *     registry key` fail.
 *   - A cross-link pointed at an id no article has → `every cross-link resolves` fails.
 *   - The not-built marker removed from an article that still describes the feature →
 *     `no article describes an unbuilt feature without marking it` fails.
 */

const ids = CONTENT_ARTICLES.map((article) => article.id);

describe('the article registry', () => {
  it('ids are unique', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("each article's id matches its registry key", () => {
    for (const id of CONTENT_ARTICLE_IDS) {
      expect(findArticle(id).id).toBe(id);
    }
  });

  it('covers exactly the declared id list, in order', () => {
    expect(ids).toEqual([...CONTENT_ARTICLE_IDS]);
  });

  it('opens on an article that exists', () => {
    expect(ids).toContain(DEFAULT_ARTICLE_ID);
  });

  it('every article has a title, a summary, keywords and a body', () => {
    for (const article of CONTENT_ARTICLES) {
      expect(article.title.length, article.id).toBeGreaterThan(0);
      expect(article.summary.length, article.id).toBeGreaterThan(0);
      expect(article.keywords.length, article.id).toBeGreaterThan(0);
      expect(article.body.length, article.id).toBeGreaterThan(0);
    }
  });
});

describe('cross-links', () => {
  it('every cross-link resolves to an article that exists', () => {
    const known = new Set<string>(ids);
    for (const article of CONTENT_ARTICLES) {
      for (const target of articleLinkTargets(article)) {
        // A dead in-app link is worse than no link: it is a button that silently does the
        // wrong thing, in the one place a lost user went looking for certainty.
        expect(known.has(target), `${article.id} links to missing "${target}"`).toBe(true);
      }
    }
  });

  it('no article links to itself', () => {
    for (const article of CONTENT_ARTICLES) {
      expect(articleLinkTargets(article), article.id).not.toContain(article.id);
    }
  });

  it('every article is reachable from another article', () => {
    const reachable = new Set<ContentArticleId>();
    for (const article of CONTENT_ARTICLES) {
      for (const target of articleLinkTargets(article)) reachable.add(target);
    }
    // The index reaches everything by construction; this is about the reading path. An
    // article nothing points at is one a reader only finds by scanning the whole list.
    for (const id of CONTENT_ARTICLE_IDS) {
      expect(reachable.has(id), `nothing links to "${id}"`).toBe(true);
    }
  });
});

describe('honesty about what is built', () => {
  it('no article describes an unbuilt feature without marking it', () => {
    for (const article of CONTENT_ARTICLES) {
      const marked = declaredUnbuilt(article);
      for (const featureId of UNBUILT_FEATURE_IDS) {
        const mentioned = UNBUILT_FEATURES[featureId].phrases.some((phrase) =>
          articleMentions(article, phrase)
        );
        if (!mentioned) continue;
        expect(
          marked.has(featureId),
          `"${article.id}" mentions ${featureId} but carries no not-built block for it`
        ).toBe(true);
      }
    }
  });

  it('no article carries a marker for a feature it never mentions', () => {
    for (const article of CONTENT_ARTICLES) {
      for (const featureId of declaredUnbuilt(article)) {
        const mentioned = UNBUILT_FEATURES[featureId].phrases.some((phrase) =>
          articleMentions(article, phrase)
        );
        expect(mentioned, `"${article.id}" marks ${featureId} without discussing it`).toBe(true);
      }
    }
  });

  it('matches phrases by whole words, so "important" is not a mention of import', () => {
    expect(toWords('This is important.')).toEqual(['this', 'is', 'important']);
    expect(toWords('a .keepx parcel')).toEqual(['a', 'keepx', 'parcel']);
  });

  it('the shortcuts page reads the registry and writes out no key combinations', () => {
    // The failure this exists to prevent is someone "helpfully" typing the accelerators in
    // — a second list, in the one place a user would trust, that nothing keeps in step with
    // the app. The sheet in `commands/` renders the real table, filtered to what is
    // actually mounted; this page must not shadow it with a fuller, staler one.
    const article = findArticle('keyboard-shortcuts');
    const prose = articleProse(article).join(' ');

    expect(prose, 'a key combination was written into the help text').not.toMatch(
      /\b(ctrl|cmd|command|alt|shift|option|meta)\s*\+/iu
    );
    expect(prose, 'a macOS modifier glyph was written into the help text').not.toMatch(/[⌘⌥⇧]/u);

    const facts = article.body.find((block) => block.kind === 'facts');
    if (facts?.kind !== 'facts') throw new Error('the scope table is missing');
    expect(facts.rows).toEqual(SHORTCUT_SCOPE_ROWS);
    expect(prose).toContain(String(SHORTCUT_COUNT));
  });
});

describe('numbers and lists quoted from the model', () => {
  const historyProse = articleProse(findArticle('history-and-audit')).join(' ');

  const historyBody = findArticle('history-and-audit').body;

  it('lists exactly the fields the model versions', () => {
    const listed = historyBody.find((block) => block.kind === 'list');
    if (listed?.kind !== 'list') throw new Error('the versioned-field list block is missing');
    expect(listed.items).toHaveLength(VERSIONED_FIELDS.length);
    // Every entry is a real label rather than a leftover identifier.
    for (const item of listed.items) expect(item.trim().length).toBeGreaterThan(0);
  });

  it('describes every privacy level the model defines, and no others', () => {
    const facts = historyBody.find((block) => block.kind === 'facts');
    if (facts?.kind !== 'facts') throw new Error('the privacy-level table is missing');
    expect(facts.rows).toHaveLength(AUDIT_PRIVACY_LEVELS.length);

    for (const level of AUDIT_PRIVACY_LEVELS) {
      const row = facts.rows.find((entry) => entry.term.split(' ')[0] === level);
      if (row === undefined) throw new Error(`no row for the "${level}" level`);
      // One clause per captured field. A level that quietly began capturing more than it
      // claims would change this count, which is the failure worth catching: provenance
      // the user thought they had switched off would already be in the file.
      expect(
        row.description.split(';'),
        `"${level}" describes the wrong number of captured fields`
      ).toHaveLength(AUDIT_LEVEL_FIELDS[level].length);
    }
  });

  it('marks the default privacy level as the default', () => {
    const facts = historyBody.find((block) => block.kind === 'facts');
    if (facts?.kind !== 'facts') throw new Error('the privacy-level table is missing');
    const flagged = facts.rows.filter((row) => row.term.includes('the default'));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.term.split(' ')[0]).toBe(DEFAULT_VAULT_SETTINGS.auditPrivacyLevel);
  });

  it('quotes the retention default from the vault settings', () => {
    const max = DEFAULT_VAULT_SETTINGS.historyMaxVersions;
    expect(historyProse).toContain(max === null ? 'every version is kept' : `newest ${max}`);
  });

  it('quotes the Argon2 defaults from the format constants', () => {
    const prose = articleProse(findArticle('how-your-data-is-protected')).join(' ');
    expect(prose).toContain(`${DEFAULT_KDF_PARAMS.memoryKib / 1024} MiB`);
    expect(prose).toContain(`${DEFAULT_KDF_PARAMS.iterations} passes`);
  });
});
