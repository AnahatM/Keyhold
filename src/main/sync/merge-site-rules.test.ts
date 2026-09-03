// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SITE_RULE_MAX, type SiteRule } from '@shared/model/site-rules.js';
import { mergeDocuments } from './merge-document.js';
import { doc, siteRule, NOW } from './test-fixtures.js';

/**
 * Per-site password rules through the merge.
 *
 * **The failure this file exists to catch is silence.** `mergeDocuments` rebuilds the merged
 * document from named parts, so a field the merge does not know about is not "left alone" — it
 * is simply not carried, and it vanishes the first time two machines sync. Nothing errors,
 * nothing is reported, and the loss only surfaces when somebody generates a password for a bank
 * that truncates at 16 and cannot say when the rule went. The first test here is the guard for
 * exactly that, and it fails if `mergeDocuments` stops writing `siteRules`.
 *
 * The rest is the same shape as `merge-saved-searches.test.ts`, because the survival rules are
 * shared — both go through `mergeCollection` — with two deliberate differences asserted below:
 * the key is the **host** rather than an id, and an exact `updatedAt` tie is broken canonically
 * so the merge commutes.
 *
 * Fault injection performed:
 *  1. Dropped `siteRules` from the merged document literal in `merge-document.ts` — fails
 *     "carries them through a merge at all".
 *  2. Passed `ours.siteRules` as both sides — fails "brings in one that exists only on the
 *     other side".
 *  3. Took `mine` unconditionally in `laterRule` — fails "takes the later edit whole".
 *  4. Returned `mine` on a tie instead of `canonicallyFirst` — fails "agrees with itself in
 *     both directions when the two were stamped together".
 *  5. Sorted by host unconditionally before the cap — fails "returns an untouched list
 *     untouched".
 *  6. Removed the `readSiteRules` normalisation from `mergeSiteRules` — fails "collapses two
 *     rules for one host before merging them".
 */

const OPTIONS = { now: NOW } as const;

function merge(
  base: ReturnType<typeof doc> | null,
  ours: ReturnType<typeof doc>,
  theirs: ReturnType<typeof doc>
): ReturnType<typeof mergeDocuments> {
  return mergeDocuments(base, ours, theirs, OPTIONS);
}

const hosts = (rules: readonly SiteRule[]): string[] => rules.map((entry) => entry.host);

describe('merging site rules', () => {
  it('carries them through a merge at all', () => {
    const ours = doc({ siteRules: [siteRule('bank')] });
    const outcome = merge(null, ours, doc());

    // If this ever fails with an empty array, the merge has stopped claiming the field and
    // every site rule in every vault is one sync away from gone.
    expect(hosts(outcome.document.siteRules)).toEqual(['bank.example']);
    expect(outcome.document.siteRules[0]?.options).toEqual({ length: 16 });
  });

  it('brings in one that exists only on the other side', () => {
    const outcome = merge(
      null,
      doc({ siteRules: [siteRule('bank')] }),
      doc({ siteRules: [siteRule('airline')] })
    );

    expect(hosts(outcome.document.siteRules).sort()).toEqual(['airline.example', 'bank.example']);
    expect(outcome.report.notes.some((note) => note.kind === 'site-rule-added')).toBe(true);
  });

  it('honours a deletion the other side made, when we did not touch it', () => {
    const base = doc({ siteRules: [siteRule('bank')] });
    const outcome = merge(base, base, doc({ siteRules: [] }));

    // With an ancestor, "present there, gone on one side, untouched on the other" is a
    // deletion. Anything else means the delete button does nothing that survives a sync.
    expect(outcome.document.siteRules).toEqual([]);
  });

  it('keeps one that was deleted there and edited here', () => {
    const base = doc({ siteRules: [siteRule('bank', { note: 'old' })] });
    const ours = doc({ siteRules: [siteRule('bank', { note: 'new', updatedAt: NOW + 1 })] });
    const outcome = merge(base, ours, doc({ siteRules: [] }));

    expect(hosts(outcome.document.siteRules)).toEqual(['bank.example']);
    expect(outcome.report.notes.some((note) => note.kind === 'site-rule-kept-unmatched')).toBe(
      true
    );
  });

  it('unions both sides when there is no ancestor to judge against', () => {
    // A two-way merge has no evidence that anything was deleted, only that one file lacks it.
    const outcome = merge(null, doc({ siteRules: [siteRule('bank')] }), doc());
    expect(hosts(outcome.document.siteRules)).toEqual(['bank.example']);
  });

  it('keys on the host, so the same discovery made twice converges on one rule', () => {
    // The reason `SiteRule` has no id. Two machines that each hit the same rejected password
    // and each wrote the constraint down would, under id-keyed identity, both keep their own
    // copy — and `ruleForUrl` would silently apply whichever came first in the list.
    const outcome = merge(
      null,
      doc({ siteRules: [siteRule('bank', { note: 'desktop' })] }),
      doc({ siteRules: [siteRule('bank', { note: 'laptop', updatedAt: NOW + 1 })] })
    );

    expect(outcome.document.siteRules).toHaveLength(1);
    expect(outcome.document.siteRules[0]?.note).toBe('laptop');
  });

  it('takes the later edit whole, never half of each', () => {
    const base = doc({ siteRules: [siteRule('bank', { note: 'old', options: { length: 20 } })] });
    const ours = doc({
      siteRules: [siteRule('bank', { note: 'no symbols', options: { symbols: false } })],
    });
    const theirs = doc({
      siteRules: [
        siteRule('bank', {
          note: '16 characters maximum',
          options: { length: 16 },
          updatedAt: NOW + 1_000,
        }),
      ],
    });

    const [merged] = merge(base, ours, theirs).document.siteRules;
    // The property that matters. Resolving `note` and `options` independently could produce
    // "no symbols" attached to a 16-character limit — a rule that describes one constraint and
    // enforces another, which is worse than either side's version and invisible until a
    // password is rejected.
    expect(merged?.note).toBe('16 characters maximum');
    expect(merged?.options).toEqual({ length: 16 });
  });

  it('keeps ours when ours is the later edit', () => {
    const base = doc({ siteRules: [siteRule('bank', { note: 'old' })] });
    const ours = doc({ siteRules: [siteRule('bank', { note: 'mine', updatedAt: NOW + 5_000 })] });
    const theirs = doc({ siteRules: [siteRule('bank', { note: 'theirs' })] });

    expect(merge(base, ours, theirs).document.siteRules[0]?.note).toBe('mine');
  });

  it('agrees with itself in both directions when the two were stamped together', () => {
    // Not exotic: copying a vault, or an import, stamps a whole list in one millisecond. A
    // tie-break that fell back to "mine" would make the merged rule depend on which machine
    // pressed the button — the one thing a sync must never do.
    const ours = doc({ siteRules: [siteRule('bank', { note: 'aaa' })] });
    const theirs = doc({ siteRules: [siteRule('bank', { note: 'zzz' })] });

    const forwards = merge(null, ours, theirs).document.siteRules;
    const backwards = merge(null, theirs, ours).document.siteRules;
    expect(forwards).toEqual(backwards);
  });

  it('raises no conflict for the user to resolve', () => {
    const base = doc({ siteRules: [siteRule('bank', { note: 'old' })] });
    const ours = doc({ siteRules: [siteRule('bank', { note: 'mine', updatedAt: NOW + 1 })] });
    const theirs = doc({ siteRules: [siteRule('bank', { note: 'theirs' })] });

    // Deliberately unlike a folder or a record. Asking somebody to adjudicate two password
    // policies in the middle of a merge that may also be asking about real credentials spends
    // their attention on the cheapest thing in the file.
    expect(merge(base, ours, theirs).report.conflicts).toEqual([]);
  });

  it('collapses two rules for one host before merging them', () => {
    // A hand-edited `.keep` can hold both, and `mergeCollection` indexes by key — so without
    // this the *second* would silently win the merge while `ruleForUrl` kept applying the
    // first, which is a rule that behaves differently before and after a sync.
    const ours = doc({
      siteRules: [
        siteRule('bank', { note: 'first' }),
        { host: 'https://www.bank.example', options: {}, updatedAt: NOW, note: 'second' },
      ],
    });

    const merged = merge(null, ours, doc()).document.siteRules;
    expect(merged).toHaveLength(1);
    expect(merged[0]?.note).toBe('first');
  });

  it('repairs a host that was never normalised, rather than keeping a rule that cannot fire', () => {
    const ours = doc({
      siteRules: [{ host: 'HTTPS://WWW.Bank.Example/login', options: {}, updatedAt: NOW }],
    });
    expect(hosts(merge(null, ours, doc()).document.siteRules)).toEqual(['bank.example']);
  });

  it('caps the combined list, since two legal lists can exceed the cap together', () => {
    const half = Math.ceil(SITE_RULE_MAX * 0.75);
    const ours = doc({
      siteRules: Array.from({ length: half }, (_unused, i) => siteRule(`a${String(i)}`)),
    });
    const theirs = doc({
      siteRules: Array.from({ length: half }, (_unused, i) => siteRule(`b${String(i)}`)),
    });

    expect(merge(null, ours, theirs).document.siteRules).toHaveLength(SITE_RULE_MAX);
  });

  it('returns an untouched list untouched, so merge(x, x) is x', () => {
    // Order included. A merge that sorted a list that already fitted would make syncing with a
    // device that has nothing new rewrite the file — which is the difference between a no-op
    // and a change every backup and every external-change banner has to account for.
    const rules = [siteRule('zebra'), siteRule('apple')];
    const same = doc({ siteRules: rules });

    const outcome = merge(same, same, same);
    expect(outcome.document.siteRules).toEqual(rules);
    expect(outcome.document).toEqual(same);
    expect(outcome.report.notes).toEqual([]);
  });
});
