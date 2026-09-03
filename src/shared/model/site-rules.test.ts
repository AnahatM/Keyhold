// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { GeneratorOptions } from './generator.js';
import {
  applySiteRule,
  bySiteRuleHost,
  normaliseSiteRule,
  readSiteRules,
  ruleForRecord,
  ruleForUrl,
  siteRuleKey,
  siteRuleProblem,
  SITE_RULE_HOST_MAX,
  SITE_RULE_MAX,
  SITE_RULE_NOTE_MAX,
  SITE_RULE_OPTION_KEYS_MAX,
  SITE_RULE_OPTION_TEXT_MAX,
  type SiteRule,
} from './site-rules.js';

/**
 * Which remembered rule applies to which site, and what a rule has to look like to be stored.
 *
 * The asymmetry that shapes every matching test here: a rule that fails to apply costs the user
 * the annoyance they already had — they set the constraint by hand, as they would have anyway. A
 * rule that applies to the **wrong** site generates a password against a constraint that site
 * never had, and the failure surfaces days later as "this password does not work" with nothing
 * on screen connecting it to a rule saved for a different host.
 *
 * So the matching is exact and deliberately unclever, and most of what is asserted below is
 * about what must *not* match.
 *
 * The validation half is here for a different reason: a `.keep` can be hand-edited and an import
 * can be handed to a user by anyone, so the cap and the shape checks are the only thing standing
 * between an arbitrary file and the generator.
 *
 * Fault injection performed:
 *  1. Stripping every leading label rather than only `www.` — fails "does not treat a subdomain
 *     as the parent site", which is the whole clever-vs-correct trade.
 *  2. Returning `''` instead of `null` when the whole host was a `www.` prefix — fails "an
 *     unusable URL keys nothing". It failed nothing at first: the case is `www.` on its own,
 *     which parses to the hostname "www.", and that input was missing from the list.
 *  3. Letting a rule's `mode` through in `applySiteRule` — fails "a site cannot change the mode
 *     the user picked".
 *  4. Spreading the rule *before* the base — fails "the rule wins, and changes nothing else".
 *  5. Dropping the `.slice(0, SITE_RULE_MAX)` from `readSiteRules` — fails "caps what it reads".
 *  6. Dropping the duplicate-host collapse — fails "collapses two rules for one host".
 *  7. Storing `rule.host` verbatim instead of through `siteRuleKey` in `normaliseSiteRule` —
 *     fails "stores the host in the form the lookup will ask for".
 *  8. Checking the host length *after* `siteRuleKey` rather than before — fails nothing on its
 *     own, since both orders refuse the same inputs; the ordering is about not handing a URL
 *     parser a megabyte, so the assertion is on the refusal and the comment carries the why.
 */

const base: GeneratorOptions = { mode: 'random', length: 24, symbols: true };
const NOW = 1_800_000_000_000;

function rule(host: string, overrides: Partial<SiteRule> = {}): SiteRule {
  return { host, options: { length: 16 }, updatedAt: NOW, ...overrides };
}

describe('the key a rule hangs on', () => {
  it('is the host, lowercased, with a full URL or a bare one', () => {
    expect(siteRuleKey('https://bank.example.com/login?next=1')).toBe('bank.example.com');
    expect(siteRuleKey('bank.example.com')).toBe('bank.example.com');
    expect(siteRuleKey('HTTPS://BANK.EXAMPLE.COM')).toBe('bank.example.com');
  });

  it('drops a leading www., because nobody thinks those are different sites', () => {
    expect(siteRuleKey('https://www.bank.example.com')).toBe('bank.example.com');
    expect(siteRuleKey('www.bank.example.com')).toBe('bank.example.com');
  });

  it('does not treat a subdomain as the parent site', () => {
    // `login.bank.example` may be a different service, and deciding otherwise needs a
    // public-suffix list this app does not ship. Conservative is the safe direction.
    expect(siteRuleKey('https://login.bank.example.com')).toBe('login.bank.example.com');
    expect(siteRuleKey('https://intranet.example.org')).not.toBe('example.org');
  });

  it('an unusable URL keys nothing, rather than keying the empty string', () => {
    // A rule saved under '' would match every unparseable URL in the vault at once.
    for (const bad of ['', '   ', 'not a url at all', '://']) {
      expect(siteRuleKey(bad), JSON.stringify(bad)).toBeNull();
    }

    // `www.` on its own parses to the hostname "www." — stripping the prefix leaves nothing,
    // and a rule keyed on the empty string would match every one of those. Found by injecting
    // the removal of that guard and watching nothing fail; the input was simply missing here.
    expect(siteRuleKey('www.')).toBeNull();
    expect(siteRuleKey('https://www.')).toBeNull();
  });

  it('handles the hosts that are not domains', () => {
    expect(siteRuleKey('http://localhost:8080/app')).toBe('localhost');
    expect(siteRuleKey('https://192.168.1.10')).toBe('192.168.1.10');
  });
});

describe('finding the rule', () => {
  const rules = [
    rule('bank.example.com', { options: { symbols: false }, note: 'rejects symbols' }),
    rule('airline.example', { options: { length: 16 } }),
  ];

  it('matches a record URL to its rule', () => {
    expect(ruleForUrl(rules, 'https://www.bank.example.com/login')?.note).toBe('rejects symbols');
  });

  it('returns nothing for a site with no rule', () => {
    expect(ruleForUrl(rules, 'https://unrelated.example')).toBeNull();
    expect(ruleForUrl(rules, 'nonsense')).toBeNull();
  });

  it('takes the first of a record’s URLs that has one, in the record’s own order', () => {
    // The URL listed first is the one the user thinks of as the site.
    const found = ruleForRecord(rules, ['https://help.example', 'https://airline.example/book']);
    expect(found?.host).toBe('airline.example');
  });

  it('returns nothing when a record has no URLs at all', () => {
    expect(ruleForRecord(rules, [])).toBeNull();
  });
});

describe('applying one', () => {
  it('the rule wins, and changes nothing else', () => {
    const applied = applySiteRule(base, rule('bank.example.com', { options: { symbols: false } }));
    expect(applied).toMatchObject({ mode: 'random', length: 24, symbols: false });
  });

  it('a site cannot change the mode the user picked', () => {
    // The mode is the deliberate choice made on the screen in front of them; a site has no
    // opinion about whether its owner finds a passphrase easier to type.
    const applied = applySiteRule(
      base,
      rule('bank.example.com', { options: { mode: 'pin' } as Partial<GeneratorOptions> })
    );
    expect(applied.mode).toBe('random');
  });

  it('no rule leaves the options exactly as they were', () => {
    expect(applySiteRule(base, null)).toBe(base);
  });
});

describe('what counts as a storable rule', () => {
  it('accepts the ordinary one', () => {
    expect(siteRuleProblem(rule('bank.example', { note: '16 characters maximum' }))).toBeNull();
  });

  it('refuses anything that is not an object', () => {
    for (const bad of [null, 'bank.example', 42, [], undefined]) {
      expect(siteRuleProblem(bad), JSON.stringify(bad ?? null)).not.toBeNull();
    }
  });

  it('refuses a host no rule could be keyed by', () => {
    expect(siteRuleProblem({ ...rule('x'), host: 'not a url at all' })).not.toBeNull();
    expect(siteRuleProblem({ ...rule('x'), host: '' })).not.toBeNull();
    expect(siteRuleProblem({ ...rule('x'), host: 42 })).not.toBeNull();
  });

  it('refuses an absurdly long host without handing it to a URL parser', () => {
    const long = `${'a'.repeat(SITE_RULE_HOST_MAX)}.example`;
    expect(siteRuleProblem({ ...rule('x'), host: long })).toContain(String(SITE_RULE_HOST_MAX));
  });

  it('refuses a note past its cap, and one that is not text', () => {
    expect(
      siteRuleProblem(rule('bank.example', { note: 'x'.repeat(SITE_RULE_NOTE_MAX) }))
    ).toBeNull();
    expect(
      siteRuleProblem(rule('bank.example', { note: 'x'.repeat(SITE_RULE_NOTE_MAX + 1) }))
    ).not.toBeNull();
    expect(siteRuleProblem({ ...rule('bank.example'), note: 7 })).not.toBeNull();
  });

  it('never repeats the user’s own words back in the reason', () => {
    // The reason reaches an error banner and possibly a screenshot. A note is prose somebody
    // wrote about their own account — "the joint one, Dad uses it too" — and a host is a
    // fragment of what is in the vault.
    const secretish = 'the-joint-account-nobody-should-see';
    const reasons = [
      siteRuleProblem({ ...rule('bank.example'), note: secretish.repeat(20) }),
      siteRuleProblem({ ...rule('bank.example'), host: `${secretish} not a url` }),
      siteRuleProblem({
        ...rule('bank.example'),
        options: { excludeCharacters: secretish.repeat(20) },
      }),
    ];

    for (const reason of reasons) {
      expect(reason).not.toBeNull();
      expect(reason).not.toContain(secretish);
    }
  });

  it('refuses generator settings that are not settings', () => {
    expect(siteRuleProblem({ ...rule('bank.example'), options: null })).not.toBeNull();
    expect(siteRuleProblem({ ...rule('bank.example'), options: [] })).not.toBeNull();
    // A nested object is the shape a hand-edited file uses to smuggle something the spread in
    // `applySiteRule` would carry straight into a generator call.
    expect(
      siteRuleProblem({ ...rule('bank.example'), options: { length: { toString: 1 } } })
    ).not.toBeNull();
    expect(siteRuleProblem({ ...rule('bank.example'), options: { length: NaN } })).not.toBeNull();
  });

  it('bounds a single setting’s text and the number of settings', () => {
    const excludeCharacters = 'x'.repeat(SITE_RULE_OPTION_TEXT_MAX + 1);
    expect(
      siteRuleProblem({ ...rule('bank.example'), options: { excludeCharacters } })
    ).not.toBeNull();

    const many = Object.fromEntries(
      Array.from({ length: SITE_RULE_OPTION_KEYS_MAX + 1 }, (_unused, i) => [`k${String(i)}`, true])
    );
    expect(siteRuleProblem({ ...rule('bank.example'), options: many })).not.toBeNull();
  });

  it('refuses one with no modification time, because the merge has nothing to weigh', () => {
    const { updatedAt: _dropped, ...withoutTime } = rule('bank.example');
    expect(siteRuleProblem(withoutTime)).not.toBeNull();
    expect(siteRuleProblem({ ...rule('bank.example'), updatedAt: Number.NaN })).not.toBeNull();
  });
});

describe('normalising one', () => {
  it('stores the host in the form the lookup will ask for', () => {
    // The failure this prevents is the worst one available: a rule the user watched themselves
    // save, sitting in the list, that never fires because `ruleForUrl` computes `bank.example`
    // and the stored key says `https://www.Bank.example/login`.
    const stored = normaliseSiteRule(rule('https://www.Bank.example/login?x=1'));
    expect(stored.host).toBe('bank.example');
    expect(ruleForUrl([stored], 'bank.example')).not.toBeNull();
  });

  it('trims and clamps the note, and drops an empty one entirely', () => {
    expect(normaliseSiteRule(rule('bank.example', { note: '  16 max  ' })).note).toBe('16 max');
    expect(
      normaliseSiteRule(rule('bank.example', { note: 'x'.repeat(SITE_RULE_NOTE_MAX + 40) })).note
    ).toHaveLength(SITE_RULE_NOTE_MAX);
    // Absent rather than empty: two spellings of "no note" is two things for the merge's
    // structural equality to disagree about.
    expect('note' in normaliseSiteRule(rule('bank.example', { note: '   ' }))).toBe(false);
  });

  it('leaves the generator settings alone rather than clamping them', () => {
    // Truncating `excludeCharacters` would silently generate against a constraint the user
    // never wrote. It is refused by `siteRuleProblem`, not quietly repaired here.
    const options = { excludeCharacters: '!@#$%' };
    expect(normaliseSiteRule(rule('bank.example', { options })).options).toEqual(options);
  });
});

describe('reading a list out of a file', () => {
  it('keeps the good and drops the unusable, rather than refusing everything', () => {
    const rules = readSiteRules([
      rule('bank.example'),
      { host: '', options: {}, updatedAt: NOW },
      'not even an object',
      rule('airline.example'),
    ]);

    expect(rules.map((entry) => entry.host)).toEqual(['bank.example', 'airline.example']);
  });

  it('treats anything that is not an array as no rules at all', () => {
    for (const bad of [undefined, null, 'rules', 42, {}]) {
      expect(readSiteRules(bad)).toEqual([]);
    }
  });

  it('normalises on the way in, so a hand-written host still matches', () => {
    const [stored] = readSiteRules([rule('HTTPS://WWW.Bank.Example/login')]);
    expect(stored?.host).toBe('bank.example');
  });

  it('collapses two rules for one host, keeping the first', () => {
    // The host is the identity, so two entries under it is the same corruption two records
    // sharing an id would be — and the merge indexes by key, so the second would silently win
    // there while `ruleForUrl` kept applying the first.
    const rules = readSiteRules([
      rule('bank.example', { note: 'first' }),
      rule('https://www.bank.example', { note: 'second' }),
    ]);

    expect(rules).toHaveLength(1);
    expect(rules[0]?.note).toBe('first');
  });

  it('caps what it reads, however many the file declares', () => {
    const many = Array.from({ length: SITE_RULE_MAX + 50 }, (_unused, index) =>
      rule(`site${String(index)}.example`)
    );
    expect(readSiteRules(many)).toHaveLength(SITE_RULE_MAX);
  });
});

describe('ordering', () => {
  it('sorts by host, the only stable order a rule has', () => {
    const sorted = [rule('c.example'), rule('a.example'), rule('b.example')]
      .sort(bySiteRuleHost)
      .map((entry) => entry.host);
    expect(sorted).toEqual(['a.example', 'b.example', 'c.example']);
  });
});
