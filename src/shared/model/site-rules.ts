// SPDX-License-Identifier: GPL-3.0-or-later
import type { GeneratorOptions } from './generator.js';

/**
 * Remembering what a particular site will accept.
 *
 * Every password manager runs into the same wall: a bank that silently truncates at 16
 * characters, a payroll site that rejects `!`, an airline that demands a digit. The generator
 * can already express all of that — `excludeCharacters`, `length`, `requireEachClass` — and
 * nothing remembers it, so the discovery is made once, painfully, at the moment a password is
 * rejected, and then made again next year.
 *
 * **Keyed by registrable host, and the rules travel with the vault.** The constraint belongs to
 * the site, not to the computer: a laptop is replaced, the bank's 16-character limit is not.
 * That is the argument for storing these in `VaultSettings` rather than machine preferences,
 * and it is the same reasoning that puts `historyMaxVersions` there.
 *
 * This module is the pure half — deciding *which* rule applies to a URL. Where the rules are
 * kept, and how two vaults' rules reconcile in a merge, is settled where the settings live.
 */

export interface SiteRule {
  /** The registrable host this applies to, already normalised. */
  readonly host: string;
  /** Whatever the generator should do differently here. A partial override, never a whole config. */
  readonly options: Partial<GeneratorOptions>;
  /**
   * Why, in the user's own words — "rejects symbols", "16 characters maximum".
   *
   * Optional but strongly wanted: a rule with no reason is indistinguishable from a mistake a
   * year later, and the instinct on finding one is to delete it and rediscover the constraint.
   */
  readonly note?: string;
}

/**
 * The host a rule is keyed by.
 *
 * `null` for anything that cannot sensibly key one: an empty string, a non-URL, or a bare path.
 * Callers must treat `null` as "no rule applies" rather than as a key of its own — a rule under
 * the empty host would apply to every site that failed to parse, which is the opposite of what
 * a per-site rule is for.
 *
 * `www.` is stripped, because `www.bank.example` and `bank.example` are the same login to
 * everybody except a URL parser. Nothing deeper is stripped: `login.bank.example` may genuinely
 * be a different service from `bank.example`, and guessing which subdomains are "the same site"
 * needs a public-suffix list this app deliberately does not ship — it would be a network fetch
 * or a large embedded table, for a heuristic that is wrong often enough to be annoying either
 * way. Being conservative means a rule sometimes does not apply where it could; being clever
 * means one applies where it should not, which is how a password gets generated against the
 * wrong constraint.
 */
export function siteRuleKey(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === '') return null;

  // A bare host is the common case in a vault — people type `bank.example`, not a full URL —
  // so a missing scheme is supplied rather than treated as a failure.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let host: string;
  try {
    host = new URL(candidate).hostname.toLowerCase();
  } catch {
    return null;
  }

  if (host === '') return null;
  // Only the leading `www.`, and only when something remains: `www.com` is a host in its own
  // right, however unlikely, and stripping it would key a rule under the empty string.
  const stripped = host.startsWith('www.') ? host.slice(4) : host;
  return stripped === '' ? null : stripped;
}

/**
 * The rule for a URL, or `null`.
 *
 * An exact host match only. See `siteRuleKey` for why nothing broader is attempted.
 */
export function ruleForUrl(rules: readonly SiteRule[], url: string): SiteRule | null {
  const key = siteRuleKey(url);
  if (key === null) return null;
  return rules.find((rule) => rule.host === key) ?? null;
}

/**
 * The first rule matching any of a record's URLs.
 *
 * A record can carry several — a login page, a help page, a mobile host — and the first that
 * has a rule wins, in the record's own order. Order is the user's: the URL they listed first is
 * the one they think of as the site.
 */
export function ruleForRecord(
  rules: readonly SiteRule[],
  urls: readonly string[]
): SiteRule | null {
  for (const url of urls) {
    const found = ruleForUrl(rules, url);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The generator options to use, with a site rule folded over the defaults.
 *
 * The rule is a *partial* override and is applied last, so a rule that says only
 * `excludeCharacters` leaves every other choice — length, mode, classes — exactly as the user
 * set it in front of them. A rule that replaced the whole configuration would silently undo
 * whatever they had just adjusted, which is the behaviour that makes people distrust a
 * remembered setting.
 *
 * A rule that names a different `mode` is ignored rather than honoured: the mode is the thing
 * the user picked deliberately on the screen in front of them, and a site cannot have an
 * opinion about whether a passphrase or a random string is more convenient for its owner.
 */
export function applySiteRule(base: GeneratorOptions, rule: SiteRule | null): GeneratorOptions {
  if (rule === null) return base;
  const { mode: _ignoredMode, ...overrides } = rule.options;
  return { ...base, ...overrides };
}
