// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { GeneratorOptions } from './generator.js';
import { applySiteRule, ruleForRecord, ruleForUrl, siteRuleKey } from './site-rules.js';

/**
 * Which remembered rule applies to which site.
 *
 * The asymmetry that shapes every test here: a rule that fails to apply costs the user the
 * annoyance they already had — they set the constraint by hand, as they would have anyway. A
 * rule that applies to the **wrong** site generates a password against a constraint that site
 * never had, and the failure surfaces days later as "this password does not work" with nothing
 * on screen connecting it to a rule saved for a different host.
 *
 * So the matching is exact and deliberately unclever, and most of what is asserted below is
 * about what must *not* match.
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
 */

const base: GeneratorOptions = { mode: 'random', length: 24, symbols: true };

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
    { host: 'bank.example.com', options: { symbols: false }, note: 'rejects symbols' },
    { host: 'airline.example', options: { length: 16 } },
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
    const applied = applySiteRule(base, {
      host: 'bank.example.com',
      options: { symbols: false },
    });
    expect(applied).toMatchObject({ mode: 'random', length: 24, symbols: false });
  });

  it('a site cannot change the mode the user picked', () => {
    // The mode is the deliberate choice made on the screen in front of them; a site has no
    // opinion about whether its owner finds a passphrase easier to type.
    const applied = applySiteRule(base, {
      host: 'bank.example.com',
      options: { mode: 'pin' } as Partial<GeneratorOptions>,
    });
    expect(applied.mode).toBe('random');
  });

  it('no rule leaves the options exactly as they were', () => {
    expect(applySiteRule(base, null)).toBe(base);
  });
});
