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
 *
 * ## Where they live: `VaultDocument.siteRules`, beside `folders` and `tags`
 *
 * Inside the encrypted body, and **not** in `VaultSettings` — which is where an earlier draft of
 * this header said they belonged. That draft was right about the *scope* and wrong about the
 * *container*, and `saved-search.ts` had already worked out why:
 *
 * **A keyed list inside `VaultSettings` merges by last-writer-wins.** `mergeSettings` settles
 * each setting as a single value, so one machine's entire rule set would silently replace the
 * other's — a constraint discovered on the laptop erased because the desktop saved a second
 * later, with nothing on screen to say it happened. On `VaultDocument` the list goes through
 * `mergeCollection` element-wise, and a rule the other machine has never seen survives.
 *
 * **It costs no format change.** `parseVaultDocument` reads `folders`, `tags` and
 * `savedSearches` additively (`?? []`), so a new document field needs no `documentVersion` bump
 * and no migration: a vault written before site rules existed opens with none and gains the
 * field on its next save, and an older build reading a newer file ignores what it does not know.
 *
 * **A rule is content, not configuration.** It is a fact the user discovered and wrote down —
 * exactly like a folder or a named query — rather than a knob describing how this vault behaves.
 *
 * ## The identity is the host, and there is deliberately no `id`
 *
 * Every other keyed collection in the document carries a random `id`. This one does not, because
 * it already has a unique natural key and a second identity would be strictly worse:
 *
 *  - `ruleForUrl` looks a rule up **by host**. With an `id` the model could represent two rules
 *    for `bank.example` with different ids, and `ruleForUrl` would silently take the first —
 *    a rule visible in the list that never applies to anything, and no way to see why.
 *  - Two machines that independently discover the same constraint would mint two different ids,
 *    and an id-keyed merge would keep **both**. Keying on the host makes independent discovery
 *    converge on one rule, which is the most likely real scenario this feature has.
 *  - Minting an id needs the CSPRNG (hard rule 2) in the path of "remember that this bank
 *    truncates at 16", for nothing.
 *
 * `src/main/sync/merge-collections.ts` therefore keys the merge on `host`, while still routing
 * through the same `mergeCollection` every other collection uses — see `mergeSiteRules`.
 */

/**
 * How many rules a vault may hold.
 *
 * Not a scannability limit, unlike `SAVED_SEARCH_MAX`: nobody reads this list top to bottom, it
 * is looked up by host. It is a bound on a file anyone can hand-edit, and on the linear scan
 * `ruleForUrl` does per lookup. 500 is far beyond any plausible vault — a rule only exists for
 * a site whose password policy is odd enough to have caused a rejection, which is a small
 * minority of a small number of logins — while keeping the whole list a rounding error inside
 * the encrypted body and the scan free.
 */
export const SITE_RULE_MAX = 500;

/**
 * The longest `note` a rule may carry.
 *
 * A sentence explaining a constraint, not a document. Bounded because it arrives from a file
 * as well as from a text box.
 */
export const SITE_RULE_NOTE_MAX = 200;

/**
 * The longest a host may be before it is refused unexamined.
 *
 * The DNS limit for a fully-qualified name. Checked *before* `siteRuleKey` runs, so a
 * hand-edited file cannot hand a megabyte of text to a URL parser.
 */
export const SITE_RULE_HOST_MAX = 253;

/**
 * The longest string any single generator option may hold inside a rule.
 *
 * Comfortably more than the entire printable-ASCII alphabet, so a legitimate
 * `excludeCharacters` — even one excluding every symbol there is — can never reach it, while a
 * file claiming a megabyte-long separator is refused.
 */
export const SITE_RULE_OPTION_TEXT_MAX = 100;

/**
 * How many keys a rule's `options` object may carry.
 *
 * Deliberately **not** a list of the generator's option names — that list lives in
 * `generator.ts` as a type and in `GENERATOR_DEFAULTS` as values, and restating it here would
 * be the second list hard rule 8 forbids. An unrecognised key is inert: `applySiteRule` spreads
 * it and the generator reads only the properties it knows. So this is a bound on size, with
 * generous headroom over the largest mode's eight options.
 */
export const SITE_RULE_OPTION_KEYS_MAX = 16;

export interface SiteRule {
  /** The registrable host this applies to, already normalised. The rule's identity. */
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
  /**
   * Epoch milliseconds, stamped on every edit.
   *
   * Present for one reason: the merge tie-breaks on it, exactly as `SavedSearch.updatedAt`
   * does. Two machines editing the rule for the same host is a real case — that is what a
   * shared host key *causes* — and without a time there is no honest way to say which of two
   * constraints is the current one. The alternative, a canonical tie-break, would let a stale
   * "16 characters" quietly overwrite a corrected "20 characters" depending on how the two
   * happened to sort, which is the exact failure this whole feature exists to prevent.
   */
  readonly updatedAt: number;
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

/**
 * Whether a value is a usable site rule, and if not, why.
 *
 * Returns a reason rather than a boolean for the same pair of callers `savedSearchProblem`
 * serves: the settings UI has to tell the user what is wrong with what they typed, and the
 * document parser has to decide whether to drop an entry that arrived from a file. A shared
 * predicate that only said "no" would have each of them inventing its own explanation.
 *
 * **Never quotes the value in the reason.** A `note` is prose the user wrote — "the joint
 * account, the one Dad also uses" — and a reason string ends up in an error banner, a
 * screenshot and possibly a log. The host is not quoted either, for the same reason a saved
 * search's query is not: it is a fragment of what is in the vault.
 *
 * Accepts a host in any form `siteRuleKey` can key; `normaliseSiteRule` is what canonicalises
 * it. So the two are safe in either order — the UI normalises then checks, the parser checks
 * then normalises — because normalisation only canonicalises the host and clamps the note.
 */
export function siteRuleProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'a site rule must be an object';
  }

  const candidate = value as Partial<SiteRule>;

  if (typeof candidate.host !== 'string') return 'its site is not text';
  // Length before parsing, deliberately. `siteRuleKey` hands its input to `new URL`, and a
  // file anyone can hand-edit is not the place to find out how a URL parser behaves on a
  // megabyte of text.
  if (candidate.host.length > SITE_RULE_HOST_MAX) {
    return `its site is longer than ${String(SITE_RULE_HOST_MAX)} characters`;
  }
  if (siteRuleKey(candidate.host) === null) return 'its site is not one a rule can be kept for';

  const optionsProblem = siteRuleOptionsProblem(candidate.options);
  if (optionsProblem !== null) return optionsProblem;

  if (candidate.note !== undefined) {
    if (typeof candidate.note !== 'string') return 'its note is not text';
    if (candidate.note.length > SITE_RULE_NOTE_MAX) {
      return `its note is longer than ${String(SITE_RULE_NOTE_MAX)} characters`;
    }
  }

  if (typeof candidate.updatedAt !== 'number' || !Number.isFinite(candidate.updatedAt)) {
    return 'it has no modification time';
  }

  return null;
}

/**
 * The overrides half, checked by *shape* rather than against a list of option names.
 *
 * Restating the generator's option names here would be a second copy of a list that already
 * exists twice — as a type in `generator.ts` and as values in `GENERATOR_DEFAULTS` — and it
 * would have to be updated in lockstep with both. An unrecognised key is harmless anyway:
 * `applySiteRule` spreads the overrides and the generator reads only the properties it knows
 * about. What is *not* harmless is an unbounded string or a nested object arriving from a file,
 * so those are what this refuses.
 */
function siteRuleOptionsProblem(options: unknown): string | null {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    return 'it has no generator settings';
  }

  const entries = Object.entries(options);
  if (entries.length > SITE_RULE_OPTION_KEYS_MAX) {
    return `it names more than ${String(SITE_RULE_OPTION_KEYS_MAX)} generator settings`;
  }

  for (const [key, entry] of entries) {
    if (typeof entry === 'boolean') continue;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) return `its ${key} setting is not a number`;
      continue;
    }
    if (typeof entry === 'string') {
      if (entry.length > SITE_RULE_OPTION_TEXT_MAX) {
        return `its ${key} setting is longer than ${String(SITE_RULE_OPTION_TEXT_MAX)} characters`;
      }
      continue;
    }
    // Names the setting, never its value. A key is one of the generator's own option names,
    // which is not the user's text; the value could be anything the file contained.
    return `its ${key} setting is not a value the generator understands`;
  }

  return null;
}

/**
 * Canonicalises a rule into its stored form.
 *
 * The host goes through `siteRuleKey`, so the stored key is *by construction* the thing
 * `ruleForUrl` will look for. Anything else — trusting a typed-in `https://www.Bank.example/`
 * to match a computed `bank.example` — is a rule that exists and never fires, which is the
 * worst outcome this feature has, because the user watched themselves save it.
 *
 * The note is trimmed and clamped; the options are **not** clamped, they are refused by
 * `siteRuleProblem`. Truncating a note loses prose. Truncating `excludeCharacters` would
 * silently generate passwords against a constraint the user never wrote.
 */
export function normaliseSiteRule(rule: SiteRule): SiteRule {
  const note = rule.note?.trim().slice(0, SITE_RULE_NOTE_MAX) ?? '';
  return {
    // `?? ''` is unreachable after `siteRuleProblem`, and is here rather than a `!` so that a
    // caller normalising before checking gets an empty host the check then refuses, instead of
    // a crash.
    host: siteRuleKey(rule.host) ?? '',
    options: rule.options,
    // Omitted entirely rather than stored empty: `exactOptionalPropertyTypes` makes "absent"
    // and "present but empty" different states, and two ways to spell "no note" is two things
    // for the merge's structural equality to disagree about.
    ...(note === '' ? {} : { note }),
    updatedAt: rule.updatedAt,
  };
}

/**
 * Site rules read out of somewhere untrusted: a `.keep` body, an import, an IPC payload.
 *
 * One function rather than the same four lines at each call site, because the cap is only a
 * guarantee if every reader applies it — and a `.keep` can be hand-edited, so "the UI enforces
 * it" is not an enforcement at all.
 *
 * Unusable entries are **dropped rather than refusing the file**, matching how saved searches
 * are read and for the same reason: a site rule is a convenience the user can recreate in
 * seconds, and refusing to open a vault because one rule has a malformed note would be a
 * self-inflicted lockout. A record gets the opposite treatment, because a record is the data.
 *
 * Duplicate hosts collapse to the first, which matters more here than it looks. The host *is*
 * the identity, so two entries for one host is the same corruption two records sharing an id
 * would be — except that this list has no `assertUniqueIds` upstream of it, and
 * `mergeCollection` indexes by key and would silently keep whichever copy came last. Collapsing
 * at the point of reading makes that unreachable, and taking the *first* matches `ruleForUrl`,
 * so what the merge sees and what the generator applies can never be two different rules.
 */
export function readSiteRules(value: unknown): readonly SiteRule[] {
  if (!Array.isArray(value)) return [];

  const kept: SiteRule[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (kept.length >= SITE_RULE_MAX) break;
    if (siteRuleProblem(entry) !== null) continue;
    const rule = normaliseSiteRule(entry as SiteRule);
    if (seen.has(rule.host)) continue;
    seen.add(rule.host);
    kept.push(rule);
  }
  return kept;
}

/** Host order. The only stable order a rule has — there is no user-chosen position. */
export function bySiteRuleHost(a: SiteRule, b: SiteRule): number {
  return a.host < b.host ? -1 : a.host > b.host ? 1 : 0;
}
