// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The shape of a vault health report, and the declarative data the score is built from.
 *
 * Lives in `@shared` because the renderer draws the dashboard: it needs the rule ids to
 * label them, the weights to explain the score, and the report shape to render it. The
 * analysis itself runs in the main process only — see `src/main/health/rules.ts` — because
 * that is the only place the passwords exist.
 *
 * **This file is types and declarative constants. No logic, and no Node imports** — it is
 * compiled into the renderer bundle, which has no Node at all.
 *
 * ## What may appear in a report
 *
 * A health report crosses the bridge, so it is bound by decision D13 exactly as the safe
 * projection is: **no secret material, and nothing derived from a secret that would narrow
 * a search for it.** In practice that means the report carries record ids, counts, dates,
 * rule names and hosts — never a password, never a hash of one, never a fragment of one,
 * and never a cluster key derived from one. `src/main/health/rules.test.ts` enforces this
 * with a property test rather than trusting anyone to remember it.
 *
 * The one deliberate exception is `CredentialHealth.passwordEntropyBits`, which is a fact
 * *about* a password in the same family as `CredentialProjection.passwordLength` — which
 * the safe projection already carries. It reveals the length and roughly which character
 * classes are present. That is the price of being able to say "28 bits" in the UI instead
 * of an unexplained red dot, and it is the same trade `PasswordStrength.guesses` already
 * makes.
 */

// ── Rules ────────────────────────────────────────────────────────────────────

/**
 * Every rule, in the order the UI should present them.
 *
 * `expiring` and `expired` are separate rules rather than one rule with two outcomes,
 * because they are separately worth switching off: plenty of people want to be told a
 * password has lapsed without being nagged for the fortnight before it does.
 */
export const HEALTH_RULE_IDS = [
  'weak',
  'reused',
  'old',
  'expiring',
  'expired',
  'insecureUrl',
  'incomplete',
  'duplicate',
  'emptyTitle',
] as const;

export type HealthRuleId = (typeof HEALTH_RULE_IDS)[number];

/** Rules that report a *group* of records rather than one at a time. */
export const CLUSTER_RULE_IDS = ['reused', 'duplicate'] as const;
export type ClusterRuleId = (typeof CLUSTER_RULE_IDS)[number];

export const HEALTH_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type HealthSeverity = (typeof HEALTH_SEVERITIES)[number];

/**
 * How loudly the UI should say it. Drives colour and sort order, not the score — the score
 * uses the weights below, which are a finer instrument than three buckets.
 */
export const HEALTH_RULE_SEVERITY: Readonly<Record<HealthRuleId, HealthSeverity>> = {
  weak: 'critical',
  reused: 'critical',
  old: 'warning',
  expiring: 'info',
  expired: 'warning',
  insecureUrl: 'warning',
  incomplete: 'info',
  duplicate: 'info',
  emptyTitle: 'info',
};

// ── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Penalty points a record loses for breaking each rule.
 *
 * These are published rather than buried so the number on the dashboard is **arguable**.
 * A health score that cannot be interrogated is a horoscope, and users are right not to
 * trust one. The reasoning, rule by rule:
 *
 *   reused (30)      The highest-impact failure in a password manager. One breach anywhere
 *                    compromises every record sharing the password, and nothing about the
 *                    other records mitigates it. Reuse is the problem this app exists for.
 *   weak (25)        Just below reuse. A weak password falls to an offline attack on its
 *                    own, but it compromises exactly one account, where reuse spreads.
 *   expired (15)     The user themselves declared this must be rotated by a date, and the
 *                    date has passed. Weighted on their stated intent, not our guess.
 *   old (10)         Age is a proxy for risk, not risk itself. A strong, unique password
 *                    that is three years old is still a strong, unique password, so this
 *                    scores well below `weak` — it is a prompt, not a finding.
 *   insecureUrl (10) Credentials sent over plain HTTP are readable in transit by anyone on
 *                    the path. Serious, but conditional on an attacker being there.
 *   duplicate (6)    A hygiene problem with a real cost: edits land on one copy and the
 *                    other silently goes stale, so the user eventually trusts a dead value.
 *   incomplete (5)   The record cannot actually log anyone in. Annoying, not dangerous.
 *   expiring (3)     A reminder whose deadline has not arrived. Nearly free.
 *   emptyTitle (3)   Unfindable by search, so effectively lost — but nothing is at risk.
 *
 * They total 107, deliberately just over `MAX_PENALTY_PER_RECORD`, so that no single record
 * can cost more than one record's worth of the score. Without that cap, one catastrophic
 * record in a vault of fifty could drag the number down further than fifty ordinary records
 * could lift it.
 *
 * Some rules are mutually exclusive on one record — `expiring` and `expired` cannot both
 * fire, and `incomplete` requires the very absence of the password that `weak` and `reused`
 * need. The worst mutually-consistent combination is
 * `reused + weak + expired + old + insecureUrl + duplicate + emptyTitle` = **99**, so a
 * vault of maximally-broken records scores 1 rather than 0. That is left as it is rather
 * than tuned to hit a round number: the weights are meant to be defensible individually,
 * and a vault at 1 is not meaningfully better off than one at 0.
 */
export const HEALTH_RULE_WEIGHTS: Readonly<Record<HealthRuleId, number>> = {
  reused: 30,
  weak: 25,
  expired: 15,
  old: 10,
  insecureUrl: 10,
  duplicate: 6,
  incomplete: 5,
  expiring: 3,
  emptyTitle: 3,
};

/**
 * The most a single record can cost the score.
 *
 * **score = 100 − (the average per-record penalty)**. That is the whole formula; there is
 * nothing else to it. A cap of 100 is what puts the result on a 0–100 scale directly.
 *
 * The cap is deliberately *not* renormalised to whichever rules are switched on, because
 * that would change the score of a vault that never broke the rule you just disabled. As
 * written, turning a rule off can only raise the score or leave it alone — never lower it.
 */
export const MAX_PENALTY_PER_RECORD = 100;

// ── Configuration ────────────────────────────────────────────────────────────

export interface HealthThresholds {
  /**
   * Below this many bits of estimated entropy, a password is "weak". 60 is chosen so an
   * eight-character mixed-case-and-symbol password (~52 bits) is flagged and a
   * sixteen-character generated one (>100 bits) is not.
   */
  readonly weakEntropyBits: number;
  /**
   * Days after which a password counts as old. Defaults from `VaultSettings`, which is the
   * single source of truth for it — this field exists so the resolved value used for a
   * given report is visible in the report itself.
   */
  readonly passwordAgeWarningDays: number;
  /** How far ahead to warn that a password is about to lapse. */
  readonly expiringWithinDays: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  weakEntropyBits: 60,
  // Kept equal to `DEFAULT_VAULT_SETTINGS.passwordAgeWarningDays`, which owns this number.
  // A guard test asserts the two agree, so this cannot drift into a second source of truth.
  passwordAgeWarningDays: 365,
  expiringWithinDays: 14,
};

/** Every rule on by default. Decision D10: the user turns off what they do not want. */
export const DEFAULT_HEALTH_RULE_TOGGLES: Readonly<Record<HealthRuleId, boolean>> = {
  weak: true,
  reused: true,
  old: true,
  expiring: true,
  expired: true,
  insecureUrl: true,
  incomplete: true,
  duplicate: true,
  emptyTitle: true,
};

/** What the caller asked for. Every field optional; unspecified means "the default". */
export interface HealthAnalysisOptions {
  /** Passed in, never read from a clock, so a report is a pure function of its inputs. */
  readonly now: number;
  readonly enabledRules?: Partial<Record<HealthRuleId, boolean>>;
  readonly thresholds?: Partial<HealthThresholds>;
}

/** What was actually used, after defaults and vault settings were folded in. */
export interface HealthConfig {
  readonly enabledRules: Readonly<Record<HealthRuleId, boolean>>;
  readonly thresholds: HealthThresholds;
}

// ── The report ───────────────────────────────────────────────────────────────

export interface HealthIssue {
  readonly rule: HealthRuleId;
  readonly severity: HealthSeverity;
  readonly credentialId: string;
  /** Which cluster this issue belongs to, for cluster rules. `null` for the rest. */
  readonly clusterId: string | null;
  /**
   * A short non-secret hint — currently the offending host for `insecureUrl`.
   *
   * The **host**, never the URL: a URL may carry credentials in its userinfo
   * (`http://user:pass@host/`), and copying one into the report would put a password in a
   * structure that crosses to the renderer. Anything added here must be checked against
   * that hazard.
   */
  readonly detail: string | null;
}

/**
 * A group of records that share a problem with each other.
 *
 * The user cannot act on "this password is reused" — they have to know *which* records to
 * go and change, so the group is the unit of the finding, not a flag on each record.
 */
export interface HealthCluster {
  /**
   * A synthetic, sequential id (`reused-1`). Deliberately **not** derived from what the
   * members have in common: a hash of a shared password would be a stable, offline-
   * attackable handle on that password, which is exactly what must not cross the bridge.
   */
  readonly id: string;
  readonly rule: ClusterRuleId;
  /** In document order. Every member, including the first — no "the others" semantics. */
  readonly credentialIds: readonly string[];
  readonly size: number;
  /**
   * A human label, where one can be given without revealing anything: for `duplicate`,
   * the host and identity, both of which the safe projection already carries. Always
   * `null` for `reused`, because the only thing those records have in common is the
   * password.
   */
  readonly label: string | null;
}

export interface CredentialHealth {
  readonly credentialId: string;
  /** In rule order, so the UI does not have to sort. */
  readonly issues: readonly HealthIssue[];
  /** See the file header for why this is permitted to cross. 0 when there is no password. */
  readonly passwordEntropyBits: number;
  /** What this record cost the score, after the per-record cap. Makes the score auditable. */
  readonly penalty: number;
}

export interface VaultHealthReport {
  /** The `now` the caller supplied. The report is a pure function of the vault and this. */
  readonly generatedAt: number;
  /** 0–100. See `HEALTH_RULE_WEIGHTS` for how it is arrived at. */
  readonly score: number;
  /** Records considered — that is, every record not in the trash. */
  readonly analysedCount: number;
  /** Records skipped because they are trashed. Surfaced so the number is explained. */
  readonly trashedCount: number;
  readonly healthyCount: number;
  /** Records flagged, per rule. A record breaking one rule twice still counts once. */
  readonly counts: Readonly<Record<HealthRuleId, number>>;
  readonly issues: readonly HealthIssue[];
  readonly clusters: readonly HealthCluster[];
  /** Only records with at least one issue. A clean vault produces an empty array. */
  readonly byCredential: readonly CredentialHealth[];
  readonly config: HealthConfig;
}
