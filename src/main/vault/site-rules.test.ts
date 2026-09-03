// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SITE_RULE_MAX, ruleForUrl } from '@shared/model/site-rules.js';
import { parseVaultDocument, serialiseVaultDocument } from './vault-service.js';
import { emptyVaultDocument } from '@shared/model/vault-document.js';

/**
 * Site rules where they meet the file.
 *
 * `site-rules.test.ts` in `@shared` proves `readSiteRules` behaves; this proves the vault body
 * actually *uses* it. The two are worth separating because the interesting failure is not a bad
 * rule getting through — it is a good one silently not being read at all, which looks identical
 * to "the user never made one" from every screen in the app.
 *
 * A `.keep` body is authenticated by the AEAD, so nothing here is defending against an attacker
 * mid-flight. It is defending against a file the *user* edited, an import, and a build we have
 * not written — which is precisely the population `parseVaultDocument`'s own header says the
 * shallow checks exist for.
 *
 * Fault injection performed:
 *  1. Replaced `readSiteRules(candidate.siteRules)` with `candidate.siteRules ?? []` in
 *     `parseVaultDocument` — fails "drops an unusable entry", "caps what it reads from a file"
 *     and "collapses two rules for one host".
 *  2. Removed the `siteRules` line from `parseVaultDocument` entirely — fails "survives being
 *     written and read back" and, in TypeScript, does not compile at all.
 *  3. Removed `siteRules: []` from `emptyVaultDocument` — does not compile.
 */

const NOW = 1_800_000_000_000;

/** The parser takes the decompressed body bytes, not a string. */
function encode(document: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(document));
}

/** A body with only the fields the parser insists on, plus whatever the test is about. */
function body(extra: Record<string, unknown> = {}): Uint8Array {
  return encode({ documentVersion: 1, records: [], folders: [], tags: [], ...extra });
}

describe('reading site rules out of a vault body', () => {
  it('survives being written and read back', () => {
    const document = {
      ...emptyVaultDocument(),
      siteRules: [
        { host: 'bank.example', options: { length: 16 }, note: '16 max', updatedAt: NOW },
      ],
    };

    const reopened = parseVaultDocument(serialiseVaultDocument(document));
    expect(reopened.siteRules).toEqual(document.siteRules);
    // The point of the whole feature, asserted end to end: the rule that came back off the
    // wire is the one the generator will find for that site.
    expect(ruleForUrl(reopened.siteRules, 'https://www.bank.example/login')?.note).toBe('16 max');
  });

  it('opens a vault written before site rules existed', () => {
    // Why no `documentVersion` bump was needed: the field is read additively, exactly like
    // `folders`, `tags` and `savedSearches`. A vault from an older build must not fail to open.
    expect(parseVaultDocument(body()).siteRules).toEqual([]);
  });

  it('ignores a `siteRules` that is not a list at all', () => {
    for (const nonsense of [42, 'bank.example', { host: 'bank.example' }, null]) {
      expect(parseVaultDocument(body({ siteRules: nonsense })).siteRules).toEqual([]);
    }
  });

  it('drops an unusable entry rather than refusing the whole vault', () => {
    // The opposite of how a malformed *record* is treated, and deliberately: refusing to open
    // a vault over a malformed generator hint would be a self-inflicted lockout, and the rule
    // is a convenience the user can recreate in seconds. A record is the data itself.
    const document = parseVaultDocument(
      body({
        siteRules: [
          { host: 'bank.example', options: { length: 16 }, updatedAt: NOW },
          { host: 'not a url at all', options: {}, updatedAt: NOW },
          { host: 'airline.example', options: {} },
          'not even an object',
        ],
      })
    );

    expect(document.siteRules.map((entry) => entry.host)).toEqual(['bank.example']);
  });

  it('normalises a hand-written host, so an edited file still produces a rule that fires', () => {
    const document = parseVaultDocument(
      body({ siteRules: [{ host: 'HTTPS://WWW.Bank.Example/login', options: {}, updatedAt: NOW }] })
    );

    expect(document.siteRules[0]?.host).toBe('bank.example');
  });

  it('collapses two rules for one host, keeping the first', () => {
    const document = parseVaultDocument(
      body({
        siteRules: [
          { host: 'bank.example', options: {}, note: 'first', updatedAt: NOW },
          { host: 'www.bank.example', options: {}, note: 'second', updatedAt: NOW + 1 },
        ],
      })
    );

    expect(document.siteRules).toHaveLength(1);
    expect(document.siteRules[0]?.note).toBe('first');
  });

  it('caps what it reads from a file, however many the file declares', () => {
    // The cap has to bind here and not only in the UI. A `.keep` is a file on the user's disk
    // that anybody with an editor can lengthen, and every later reader — the merge, the
    // generator's lookup, the settings list — assumes the bound already holds.
    const many = Array.from({ length: SITE_RULE_MAX + 50 }, (_unused, index) => ({
      host: `site${String(index)}.example`,
      options: { length: 16 },
      updatedAt: NOW,
    }));

    expect(parseVaultDocument(body({ siteRules: many })).siteRules).toHaveLength(SITE_RULE_MAX);
  });
});
