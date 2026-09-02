// SPDX-License-Identifier: GPL-3.0-or-later
import type { Credential } from '@shared/model/credential.js';
import {
  DEFAULT_HEALTH_RULE_TOGGLES,
  DEFAULT_HEALTH_THRESHOLDS,
  HEALTH_RULE_IDS,
  HEALTH_RULE_SEVERITY,
  HEALTH_RULE_WEIGHTS,
  MAX_PENALTY_PER_RECORD,
  type ClusterRuleId,
  type CredentialHealth,
  type HealthAnalysisOptions,
  type HealthCluster,
  type HealthConfig,
  type HealthIssue,
  type HealthRuleId,
  type VaultHealthReport,
} from '@shared/model/health.js';
import type { VaultDocument } from '@shared/model/vault-document.js';

/**
 * The offline vault health rules, as **one pure function over a document**.
 *
 * Nothing here reads a clock, a file, a key or a network. `now` arrives as a parameter, so
 * a report is a deterministic function of (document, options) and every boundary in it can
 * be tested by moving a number by one millisecond rather than by waiting a year.
 *
 * **There is no network code in this file and there must never be.** The Have I Been Pwned
 * check is a separate, opt-in, off-by-default feature living behind its own kill switch
 * (roadmap phase 13). Keyhold's premise is that it works, completely, with the network
 * cable pulled out; these rules are what makes that premise true of the health dashboard.
 *
 * ## What crosses the bridge
 *
 * The report goes to the renderer, so it is bound by decision D13. Passwords are compared
 * here, in this process, and never leave it: the reuse map is a local `Map` whose keys go
 * out of scope with the function, and the cluster ids that come out are synthetic counters
 * rather than anything derived from a password. `rules.test.ts` proves this with a
 * property test instead of trusting the reader of this comment.
 *
 * ## Trashed records
 *
 * Excluded from every rule, unconditionally, before any rule runs. Somebody who deleted a
 * weak password has dealt with it; continuing to score them down for it would train them
 * to ignore the dashboard.
 */

const MS_PER_DAY = 86_400_000;

// ── Password entropy ─────────────────────────────────────────────────────────

/**
 * Character-class pool sizes. Symbols is the count of printable ASCII that is not
 * alphanumeric (0x20–0x7E is 95 characters, of which 62 are alphanumeric).
 */
const POOL_LOWER = 26;
const POOL_UPPER = 26;
const POOL_DIGIT = 10;
const POOL_SYMBOL = 33;
/** A flat allowance for anything outside printable ASCII — accented letters, CJK, emoji. */
const POOL_OTHER = 100;

/**
 * A cheap entropy estimate: `length × log2(pool)`, where the pool is the union of the
 * character classes actually present.
 *
 * **Be honest about what this is.** It assumes every character was drawn independently and
 * uniformly from that pool, which is true of a generated password and false of a
 * human-chosen one. Specifically, it does not know about:
 *
 *   - dictionary words — `correcthorsebatterystaple` scores 117 bits here
 *   - names, dates and years — `Anahat1998!` scores 72 bits and is guessable in seconds
 *   - keyboard walks (`qwerty`), sequences (`abc123`), and repeats (`aaaaaaaa`)
 *   - the l33t substitutions and capitalise-the-first-letter habits that every cracking
 *     rule set has encoded since the 1990s
 *
 * So it **over**-estimates human passwords and is accurate for generated ones. It is a
 * lower bound on badness, not a measure of strength: a password it calls weak really is
 * weak, while one it calls strong may not be.
 *
 * Why not zxcvbn, which this project already depends on? Because `@zxcvbn-ts/core` carries
 * several megabytes of dictionaries and costs milliseconds per password, and the health
 * dashboard runs over the whole vault — thousands of records — every time it is opened.
 * This runs in microseconds with no allocation beyond a handful of booleans. zxcvbn is the
 * right tool for the one password the user is typing right now (see
 * `@shared/model/strength.ts`); this is the right tool for scanning everything at once.
 *
 * Returns bits rounded to two decimal places, so the number the report shows is exactly
 * the number the threshold comparison was made against.
 */
export function passwordEntropyBits(password: string): number {
  if (password === '') return 0;

  let hasLower = false;
  let hasUpper = false;
  let hasDigit = false;
  let hasSymbol = false;
  let hasOther = false;
  let length = 0;

  // Iterating the string yields whole code points, so an emoji counts as one character
  // rather than two UTF-16 units — otherwise a short emoji password would look long.
  for (const character of password) {
    length += 1;
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x61 && code <= 0x7a) hasLower = true;
    else if (code >= 0x41 && code <= 0x5a) hasUpper = true;
    else if (code >= 0x30 && code <= 0x39) hasDigit = true;
    else if (code >= 0x20 && code <= 0x7e) hasSymbol = true;
    else hasOther = true;
  }

  let pool = 0;
  if (hasLower) pool += POOL_LOWER;
  if (hasUpper) pool += POOL_UPPER;
  if (hasDigit) pool += POOL_DIGIT;
  if (hasSymbol) pool += POOL_SYMBOL;
  if (hasOther) pool += POOL_OTHER;

  // Only reachable if every character was a control character, which `hasOther` catches —
  // but a pool of 1 would yield 0 bits silently, so the guard is explicit.
  if (pool <= 1) return 0;

  return Math.round(length * Math.log2(pool) * 100) / 100;
}

// ── URL normalisation ────────────────────────────────────────────────────────

/**
 * Extracts a comparable host from something the user typed into a URL field.
 *
 * Hand-rolled rather than `new URL()` because the field accepts anything a human pastes —
 * `example.com`, `Example.COM/login`, `http://u:p@host:8080/x?y#z` — and `new URL` throws
 * on the first of those. This never throws and never allocates a `URL` object per record.
 *
 * Lower-cased, port and userinfo and path removed, a trailing dot removed, and a leading
 * `www.` removed, because `www.github.com` and `github.com` are the same account to a
 * human and duplicate detection has to agree with the human.
 *
 * Case is folded here and only here: **hosts are case-insensitive, passwords are not.**
 */
export function normaliseHost(url: string): string | null {
  let rest = url.trim();
  if (rest === '') return null;

  const schemeEnd = rest.indexOf('://');
  if (schemeEnd > 0 && /^[a-z][a-z0-9+.-]*$/i.test(rest.slice(0, schemeEnd))) {
    rest = rest.slice(schemeEnd + 3);
  }

  const authorityEnd = rest.search(/[/?#]/);
  let authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);

  // `lastIndexOf`: a password in the userinfo may itself contain an '@'.
  const userinfoEnd = authority.lastIndexOf('@');
  if (userinfoEnd !== -1) authority = authority.slice(userinfoEnd + 1);

  let host: string;
  if (authority.startsWith('[')) {
    const bracketEnd = authority.indexOf(']');
    host = bracketEnd === -1 ? authority.slice(1) : authority.slice(1, bracketEnd);
  } else {
    const portStart = authority.indexOf(':');
    host = portStart === -1 ? authority : authority.slice(0, portStart);
  }

  host = host.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('www.')) host = host.slice(4);

  return host === '' ? null : host;
}

/** Hosts for which plain HTTP is normal and correct, not a finding. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Whether plain HTTP to this host is fine.
 *
 * A local development server, a router admin page on 127.0.0.1, a container on
 * `api.localhost` — these are legitimately unencrypted, and flagging them would teach the
 * user that the insecure-URL rule cries wolf, which costs more than the rule is worth.
 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || IPV4_LOOPBACK.test(host);
}

// ── Configuration resolution ─────────────────────────────────────────────────

/**
 * Folds defaults, vault settings and caller overrides into the config actually used.
 *
 * `passwordAgeWarningDays` comes from `VaultSettings`, which owns it — the default in
 * `DEFAULT_HEALTH_THRESHOLDS` is a fallback for callers with no document, not a second
 * source of truth. An explicit caller override still wins, so a "what if I tightened
 * this?" preview needs no settings write.
 */
export function resolveHealthConfig(
  document: VaultDocument,
  options: HealthAnalysisOptions
): HealthConfig {
  return {
    enabledRules: { ...DEFAULT_HEALTH_RULE_TOGGLES, ...options.enabledRules },
    thresholds: {
      ...DEFAULT_HEALTH_THRESHOLDS,
      passwordAgeWarningDays: document.settings.passwordAgeWarningDays,
      ...options.thresholds,
    },
  };
}

// ── Cluster detection ────────────────────────────────────────────────────────

/**
 * Indices of records sharing a password, grouped.
 *
 * The password is the key of a `Map` that exists only for the length of this call and is
 * never returned, logged, or stringified. What comes out is positions in an array.
 *
 * **An empty password is not reuse.** Half a vault may have no password yet; telling those
 * users they all share one would be both wrong and the fastest way to get the rule turned
 * off. `incomplete` is the rule for that case.
 *
 * **Comparison is exact, including case**, because passwords are case-sensitive: `hunter2`
 * and `Hunter2` are two different passwords and changing one does not fix the other.
 */
function reusedPasswordGroups(records: readonly Credential[]): number[][] {
  const byPassword = new Map<string, number[]>();

  records.forEach((record, index) => {
    const password = record.fields.password;
    if (password === '') return;

    const bucket = byPassword.get(password);
    if (bucket === undefined) byPassword.set(password, [index]);
    else bucket.push(index);
  });

  // Map iteration is insertion-ordered, so clusters come out in order of first appearance
  // and a report is byte-identical between runs on the same document.
  return [...byPassword.values()].filter((group) => group.length > 1);
}

interface DuplicateKey {
  readonly key: string;
  readonly label: string;
}

/**
 * The identity two records must share to be "the same account".
 *
 * Host **and** identity, where identity is the username if there is one and the email
 * otherwise. Preferring the username is deliberate: two records on the same site with the
 * same email but different usernames are two genuinely different accounts, and merging
 * them in the UI would be the wrong advice.
 *
 * The known limit: a record identified by username and its twin identified only by email
 * will not be matched. Catching that needs a union-find over two keys per record, and the
 * cost of a missed duplicate is a suggestion nobody sees, while the cost of a false one is
 * a user being told to merge two accounts that are not the same.
 *
 * Only the **primary** (first) URL is used — the record model documents the first URL as
 * primary, and a record listing five mirrors of a site is not five chances to be a
 * duplicate.
 */
function duplicateKey(record: Credential): DuplicateKey | null {
  const primaryUrl = record.fields.urls[0];
  if (primaryUrl === undefined) return null;

  const host = normaliseHost(primaryUrl);
  if (host === null) return null;

  const username = record.fields.username.trim().toLowerCase();
  const email = record.fields.email.trim().toLowerCase();
  const identity = username === '' ? email : username;
  if (identity === '') return null;

  // NUL separator: it cannot occur in either half, so no pair of values can collide by
  // straddling the boundary.
  return { key: `${host}\u0000${identity}`, label: `${host} · ${identity}` };
}

interface DuplicateGroup {
  readonly indices: number[];
  readonly label: string;
}

function duplicateGroups(records: readonly Credential[]): DuplicateGroup[] {
  const byKey = new Map<string, DuplicateGroup>();

  records.forEach((record, index) => {
    const identity = duplicateKey(record);
    if (identity === null) return;

    const group = byKey.get(identity.key);
    if (group === undefined) byKey.set(identity.key, { indices: [index], label: identity.label });
    else group.indices.push(index);
  });

  return [...byKey.values()].filter((group) => group.indices.length > 1);
}

// ── Expiry ───────────────────────────────────────────────────────────────────

/**
 * When this record's password is next due, or `null` if the user never said.
 *
 * Both `expiresAt` (an explicit date) and `rotationIntervalDays` (an interval from the
 * last password change) may be set. The **earlier** wins: they are two ways of saying "by
 * then", and honouring the later one would let one setting quietly cancel the other.
 */
export function passwordDueAt(record: Credential): number | null {
  const explicit = record.meta.expiresAt;
  const interval = record.meta.rotationIntervalDays;
  const rotational =
    interval === null ? null : record.meta.passwordUpdatedAt + interval * MS_PER_DAY;

  if (explicit === null) return rotational;
  if (rotational === null) return explicit;
  return Math.min(explicit, rotational);
}

// ── The analysis ─────────────────────────────────────────────────────────────

/** `noUncheckedIndexedAccess` makes the bounds check explicit; the index always exists. */
function pushIssue(buckets: HealthIssue[][], index: number, issue: HealthIssue): void {
  buckets[index]?.push(issue);
}

function issue(
  rule: HealthRuleId,
  credentialId: string,
  clusterId: string | null = null,
  detail: string | null = null
): HealthIssue {
  return { rule, severity: HEALTH_RULE_SEVERITY[rule], credentialId, clusterId, detail };
}

/**
 * Analyses a vault and returns its health report.
 *
 * Pure: no I/O, no clock, no network, no mutation of the document. Every threshold and
 * every toggle is resolved from `options` and the vault's own settings, and the resolved
 * values travel back in `report.config` so the dashboard can say what it actually checked.
 */
export function analyseVault(
  document: VaultDocument,
  options: HealthAnalysisOptions
): VaultHealthReport {
  const config = resolveHealthConfig(document, options);
  const { enabledRules, thresholds } = config;
  const now = options.now;

  // Trashed records leave the analysis here, once, rather than being re-checked by each
  // rule — a rule that forgot the check would otherwise be a silent bug in one rule only.
  const active = document.records.filter((record) => record.trashedAt === null);
  const trashedCount = document.records.length - active.length;

  const perRecord: HealthIssue[][] = active.map(() => []);
  const clusters: HealthCluster[] = [];

  const ageCutoff = now - thresholds.passwordAgeWarningDays * MS_PER_DAY;
  const expiringHorizon = now + thresholds.expiringWithinDays * MS_PER_DAY;

  const entropy = active.map((record) => passwordEntropyBits(record.fields.password));

  active.forEach((record, index) => {
    const { password, username, email, urls } = record.fields;
    const hasPassword = password !== '';

    // weak — only where there is a password to be weak. A missing password is `incomplete`,
    // and reporting it twice would double-count it in the score.
    if (enabledRules.weak && hasPassword) {
      const bits = entropy[index] ?? 0;
      if (bits < thresholds.weakEntropyBits) {
        pushIssue(perRecord, index, issue('weak', record.id));
      }
    }

    // old — strictly older than the window. A password changed exactly N days ago is N days
    // old, not older than N days, so the boundary belongs to "fine".
    if (enabledRules.old && hasPassword && record.meta.passwordUpdatedAt < ageCutoff) {
      pushIssue(perRecord, index, issue('old', record.id));
    }

    // expired / expiring — driven by what the user declared, so no password check: if they
    // set a rotation date on a record, they meant it.
    const dueAt = passwordDueAt(record);
    if (dueAt !== null) {
      // `<=`: at the instant it is due, it is due. A deadline that has arrived has passed.
      if (dueAt <= now) {
        if (enabledRules.expired) pushIssue(perRecord, index, issue('expired', record.id));
      } else if (enabledRules.expiring && dueAt <= expiringHorizon) {
        pushIssue(perRecord, index, issue('expiring', record.id));
      }
    }

    // insecureUrl — one issue per record even with several bad URLs, so the score counts
    // the record once. The detail carries the host, never the URL (see `HealthIssue`).
    if (enabledRules.insecureUrl) {
      for (const url of urls) {
        if (!url.trim().toLowerCase().startsWith('http://')) continue;
        const host = normaliseHost(url);
        if (host === null || isLoopbackHost(host)) continue;
        pushIssue(perRecord, index, issue('insecureUrl', record.id, null, host));
        break;
      }
    }

    // incomplete — unusable as a login: nothing to type, or nobody to type it as.
    if (enabledRules.incomplete) {
      const hasIdentity = username.trim() !== '' || email.trim() !== '';
      if (!hasPassword || !hasIdentity) {
        pushIssue(perRecord, index, issue('incomplete', record.id));
      }
    }

    // emptyTitle — search is how anything is found in a vault of thousands, and an
    // untitled record is invisible to it however complete the rest of it is.
    if (enabledRules.emptyTitle && record.title.trim() === '') {
      pushIssue(perRecord, index, issue('emptyTitle', record.id));
    }
  });

  if (enabledRules.reused) {
    addClusters(
      reusedPasswordGroups(active).map((indices) => ({ indices, label: null })),
      {
        rule: 'reused',
        active,
        perRecord,
        clusters,
      }
    );
  }

  if (enabledRules.duplicate) {
    addClusters(duplicateGroups(active), { rule: 'duplicate', active, perRecord, clusters });
  }

  return buildReport({ active, perRecord, entropy, clusters, config, now, trashedCount });
}

interface ClusterSink {
  readonly rule: ClusterRuleId;
  readonly active: readonly Credential[];
  readonly perRecord: HealthIssue[][];
  readonly clusters: HealthCluster[];
}

function addClusters(
  groups: readonly { readonly indices: readonly number[]; readonly label: string | null }[],
  sink: ClusterSink
): void {
  groups.forEach((group, position) => {
    // Sequential and scoped to the rule, so the id says nothing about the members.
    const id = `${sink.rule}-${position + 1}`;
    const credentialIds = group.indices.map((index) => sink.active[index]?.id ?? '');

    sink.clusters.push({
      id,
      rule: sink.rule,
      credentialIds,
      size: credentialIds.length,
      label: group.label,
    });

    for (const index of group.indices) {
      const record = sink.active[index];
      if (record === undefined) continue;
      pushIssue(sink.perRecord, index, issue(sink.rule, record.id, id));
    }
  });
}

interface ReportInput {
  readonly active: readonly Credential[];
  readonly perRecord: readonly HealthIssue[][];
  readonly entropy: readonly number[];
  readonly clusters: readonly HealthCluster[];
  readonly config: HealthConfig;
  readonly now: number;
  readonly trashedCount: number;
}

function buildReport(input: ReportInput): VaultHealthReport {
  const { active, perRecord, entropy, clusters, config, now, trashedCount } = input;

  const counts: Record<HealthRuleId, number> = {
    weak: 0,
    reused: 0,
    old: 0,
    expiring: 0,
    expired: 0,
    insecureUrl: 0,
    incomplete: 0,
    duplicate: 0,
    emptyTitle: 0,
  };

  const ruleOrder = new Map(HEALTH_RULE_IDS.map((rule, position) => [rule, position]));

  const byCredential: CredentialHealth[] = [];
  const issues: HealthIssue[] = [];
  let totalPenalty = 0;
  let healthyCount = 0;

  active.forEach((record, index) => {
    const recordIssues = [...(perRecord[index] ?? [])].sort(
      (a, b) => (ruleOrder.get(a.rule) ?? 0) - (ruleOrder.get(b.rule) ?? 0)
    );

    if (recordIssues.length === 0) {
      healthyCount += 1;
      return;
    }

    let raw = 0;
    for (const recordIssue of recordIssues) {
      counts[recordIssue.rule] += 1;
      raw += HEALTH_RULE_WEIGHTS[recordIssue.rule];
    }

    const penalty = Math.min(raw, MAX_PENALTY_PER_RECORD);
    totalPenalty += penalty;
    issues.push(...recordIssues);
    byCredential.push({
      credentialId: record.id,
      issues: recordIssues,
      passwordEntropyBits: entropy[index] ?? 0,
      penalty,
    });
  });

  // **score = 100 − the average per-record penalty**, and nothing else. The per-record cap
  // being 100 is what makes that arithmetic come out on a 0–100 scale directly.
  //
  // The cap is deliberately *not* renormalised to the enabled rules. Doing so would make
  // switching a rule off change the score of a vault that never broke that rule, which is
  // indefensible to a user. As written the property is simple and monotone: **turning a
  // rule off can only raise the score or leave it alone, never lower it.**
  //
  // An empty vault is not unhealthy, it is unmeasured — reporting 0 would be a lie in the
  // alarming direction.
  const score =
    active.length === 0
      ? 100
      : Math.max(0, Math.min(100, Math.round(100 - totalPenalty / active.length)));

  return {
    generatedAt: now,
    score,
    analysedCount: active.length,
    trashedCount,
    healthyCount,
    counts,
    issues,
    clusters,
    byCredential,
    config,
  };
}
