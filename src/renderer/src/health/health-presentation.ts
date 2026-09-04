// SPDX-License-Identifier: GPL-3.0-or-later
import {
  CLUSTER_RULE_IDS,
  HEALTH_RULE_IDS,
  HEALTH_RULE_SEVERITY,
  HEALTH_RULE_WEIGHTS,
  type HealthCluster,
  type HealthIssue,
  type HealthRuleId,
  type HealthSeverity,
  type VaultHealthReport,
} from '@shared/model/health.js';
import type { StatusTone } from '../components/Feedback.js';
import type { IconName } from '../components/Icon.js';

/**
 * Turning a health report into something a person can act on.
 *
 * Pure, and deliberately outside the components, for the same reason `origin-labels.ts` is:
 * these strings and this ordering are the feature. A dashboard that renders `insecureUrl`
 * and sorts alphabetically is a database dump; one that says "Sent over plain HTTP" and puts
 * reuse at the top is the thing people opened.
 *
 * Keeping it here also means it can be tested directly, which matters more than usual —
 * `@testing-library/react` is not a dependency of this project, so the components themselves
 * are only exercised through the mounted-DOM guard in `health-no-secrets.test.tsx`.
 *
 * ## Two standing constraints
 *
 * **Nothing here may render a password.** The report carries none (see the header of
 * `@shared/model/health.ts`), so the only way one could appear is if this module invented
 * it. It does not derive strings from `passwordEntropyBits` beyond a rounded bit count, and
 * `health-no-secrets.test.tsx` asserts the property over rendered markup rather than
 * trusting that sentence.
 *
 * **Severity is never carried by colour alone.** Every severity has a word and a symbol as
 * well as a tone (WCAG 1.4.1). On the one screen in the app whose whole job is flagging
 * problems, a colour-only signal would be exactly the wrong place to save a few pixels.
 */

// ── Rules, in English ────────────────────────────────────────────────────────

/**
 * Exhaustive `Record`s rather than lookups with a fallback: a new rule with no label here
 * is a compile error instead of an identifier leaking onto the screen.
 */
export const RULE_LABELS: Readonly<Record<HealthRuleId, string>> = {
  missingTotp: 'No second factor',
  reused: 'Reused password',
  weak: 'Weak password',
  expired: 'Past its rotation date',
  old: 'Not changed in a long time',
  insecureUrl: 'Sent over plain HTTP',
  duplicate: 'Looks like a duplicate record',
  incomplete: 'Cannot sign anyone in',
  expiring: 'Due for rotation soon',
  emptyTitle: 'No name',
};

/** What the rule actually tests. Phrased as the check, not as the verdict. */
export const RULE_DESCRIPTIONS: Readonly<Record<HealthRuleId, string>> = {
  missingTotp:
    'The record has no one-time-password secret, so the password is the only thing protecting it.',
  reused: 'The same password appears on more than one record.',
  weak: 'Estimated entropy is below the configured threshold.',
  expired: 'An expiry date or rotation interval you set has already passed.',
  old: 'The password has not been changed within the configured age.',
  insecureUrl: 'A saved address starts with http://, so anything sent to it travels in clear.',
  duplicate: 'Two records share a web host and a username or email.',
  incomplete: 'There is no password, or no username and no email.',
  expiring: 'An expiry date or rotation interval you set is coming up.',
  emptyTitle: 'A record with no name cannot be found by searching for it.',
};

/** What to do about it. One sentence, imperative, no hedging. */
export const RULE_ADVICE: Readonly<Record<HealthRuleId, string>> = {
  missingTotp:
    'Check whether the site offers two-factor authentication, and add the code to this record if it does.',
  reused:
    'Give each of these records its own generated password, starting with the one that matters most.',
  weak: 'Replace it with a generated password. Sixteen characters is comfortably past the threshold.',
  expired: 'Change the password, or clear the rotation reminder if it no longer applies.',
  old: 'Worth a refresh, but a strong unique password does not become weak with age — this is a prompt, not a finding.',
  insecureUrl: 'Check whether the site offers https:// and save that address instead.',
  duplicate:
    'Keep the record you actually use and move the other to Trash, so edits cannot land on the stale copy.',
  incomplete:
    'Fill in the missing password, username or email — otherwise the record cannot sign you in.',
  expiring:
    'Nothing is wrong yet. Change the password before the date if you still want the reminder.',
  emptyTitle: 'Give it a name you would search for.',
};

// ── Severity ─────────────────────────────────────────────────────────────────

export const SEVERITY_LABELS: Readonly<Record<HealthSeverity, string>> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Note',
};

/**
 * A shape alongside the word and the colour.
 *
 * Three distinguishable glyphs, not three coloured dots: a triangle, a circle and a square
 * are still three different things in greyscale, at low vision, and in the high-contrast
 * theme.
 */
/**
 * Three shapes that differ without colour.
 *
 * This is the load-bearing case for icons on a severity scale: `SEVERITY_TONES` below carries
 * the same information in hue, and hue alone is not allowed to be the signal (WCAG 1.4.1).
 * The shapes were `▲ ● ■`, which differed but meant nothing on their own; a triangle that
 * shouts, a circle that informs and a bar that merely notes are the same three steps drawn so
 * that the drawing says which is which.
 */
export const SEVERITY_ICONS: Readonly<Record<HealthSeverity, IconName>> = {
  critical: 'warning',
  warning: 'info',
  info: 'minus',
};

export const SEVERITY_TONES: Readonly<Record<HealthSeverity, StatusTone>> = {
  critical: 'danger',
  warning: 'warning',
  info: 'info',
};

// ── Ordering ─────────────────────────────────────────────────────────────────

/**
 * Rules ordered by what they cost, heaviest first.
 *
 * Taken from `HEALTH_RULE_WEIGHTS` rather than written out again, because the weights
 * already encode the argument — reuse spreads and age does not. A second hand-maintained
 * ordering would be a second list, and it would be the one that drifted.
 *
 * Ties fall back to `HEALTH_RULE_IDS`, which is documented as the order the UI should
 * present them in, so the result is deterministic rather than dependent on sort stability.
 */
export const RULES_BY_IMPACT: readonly HealthRuleId[] = [...HEALTH_RULE_IDS].sort((a, b) => {
  const byWeight = HEALTH_RULE_WEIGHTS[b] - HEALTH_RULE_WEIGHTS[a];
  if (byWeight !== 0) return byWeight;
  return HEALTH_RULE_IDS.indexOf(a) - HEALTH_RULE_IDS.indexOf(b);
});

const CLUSTER_RULES = new Set<HealthRuleId>(CLUSTER_RULE_IDS);

/** Whether a rule reports groups of records or one record at a time. */
export function isClusterRule(rule: HealthRuleId): boolean {
  return CLUSTER_RULES.has(rule);
}

// ── Grouping ─────────────────────────────────────────────────────────────────

export interface RuleGroup {
  readonly rule: HealthRuleId;
  readonly label: string;
  readonly description: string;
  readonly advice: string;
  readonly severity: HealthSeverity;
  /** Penalty points one record loses for breaking this rule. Shown, not hidden. */
  readonly weight: number;
  /** Records flagged. A record breaking one rule twice still counts once. */
  readonly flaggedCount: number;
  /** `weight × flaggedCount` — this rule's raw contribution before the per-record cap. */
  readonly points: number;
  /** For record rules. Empty for cluster rules, which are rendered as clusters. */
  readonly issues: readonly HealthIssue[];
  /** For cluster rules. Empty for the rest. */
  readonly clusters: readonly HealthCluster[];
  readonly presentation: 'clusters' | 'records';
}

/**
 * The findings, grouped by rule and ordered by impact.
 *
 * Only rules that actually fired appear. A section reading "Weak password — 0 records" on
 * every clean vault is noise that trains people to skim past the sections that are not zero,
 * and the toggle list already shows which checks are running.
 */
export function groupIssuesByRule(report: VaultHealthReport): readonly RuleGroup[] {
  const groups: RuleGroup[] = [];

  for (const rule of RULES_BY_IMPACT) {
    const flaggedCount = report.counts[rule];
    if (flaggedCount === 0) continue;

    const clusters = report.clusters.filter((cluster) => cluster.rule === rule);
    const issues = report.issues.filter((issue) => issue.rule === rule);

    groups.push({
      rule,
      label: RULE_LABELS[rule],
      description: RULE_DESCRIPTIONS[rule],
      advice: RULE_ADVICE[rule],
      severity: HEALTH_RULE_SEVERITY[rule],
      weight: HEALTH_RULE_WEIGHTS[rule],
      flaggedCount,
      points: HEALTH_RULE_WEIGHTS[rule] * flaggedCount,
      issues: isClusterRule(rule) ? [] : issues,
      clusters,
      presentation: isClusterRule(rule) ? 'clusters' : 'records',
    });
  }

  return groups;
}

// ── Clusters ─────────────────────────────────────────────────────────────────

/**
 * How a cluster is announced.
 *
 * **The cluster's `id` is never shown.** It is a synthetic sequential counter — deliberately
 * not derived from what the members share, because a hash of a shared password would be a
 * stable, offline-attackable handle on that password crossing the bridge. Printing
 * `reused-1` would invite a user to read meaning into a number that has none, so the heading
 * uses this group's position in the list instead, which is honest about being arbitrary.
 *
 * `duplicate` clusters do carry a label — a host and an identity, both of which the safe
 * projection already holds — and that is worth showing, because it names the account.
 */
export function clusterHeading(cluster: HealthCluster, ordinal: number): string {
  if (cluster.label !== null && cluster.label !== '') return cluster.label;
  return `Group ${ordinal}`;
}

/** The line under the heading: what the members have in common, and how many there are. */
export function clusterCaption(cluster: HealthCluster): string {
  const records = `${cluster.size} record${cluster.size === 1 ? '' : 's'}`;
  return cluster.rule === 'reused'
    ? `${records} share one password`
    : `${records} look like the same account`;
}

// ── Records ──────────────────────────────────────────────────────────────────

/**
 * The little a dashboard row needs in order to name a record.
 *
 * Narrower than `CredentialProjection` on purpose — a `CredentialProjection` satisfies it,
 * but stating only these four fields keeps the surface small enough that "does the dashboard
 * touch anything secret?" is answered by reading one interface.
 */
export interface HealthRecordRef {
  readonly id: string;
  readonly title: string;
  readonly username: string;
  readonly email: string;
}

/**
 * What to call a record in a list.
 *
 * Falls through title → username → email → a placeholder, because the `emptyTitle` rule
 * guarantees some of these rows have no title at all, and "" is not a link anyone can click.
 */
export function recordLabel(record: HealthRecordRef | undefined): string {
  if (record === undefined) return 'Record no longer in this vault';
  if (record.title.trim() !== '') return record.title;
  if (record.username.trim() !== '') return record.username;
  if (record.email.trim() !== '') return record.email;
  return 'Untitled record';
}

/** The secondary line on a row: who the record signs in as. Empty when nothing is known. */
export function recordSubtitle(record: HealthRecordRef | undefined): string {
  if (record === undefined) return '';
  const identity = record.username.trim() !== '' ? record.username : record.email.trim();
  // Suppressed when it would just repeat the label — a row reading "bob / bob" is noise.
  return identity === recordLabel(record) ? '' : identity;
}

/**
 * "≈28 bits", or nothing at all.
 *
 * `passwordEntropyBits` is the one fact about a password the report is allowed to carry, and
 * it is here so the UI can say a number instead of showing an unexplained red dot. Zero
 * means there is no password rather than a password worth zero bits, so it renders as an
 * em dash — `incomplete` is the rule that has something to say about that record.
 *
 * Rounded, and prefixed with `≈`, because the estimate is a `length × log2(pool)` heuristic
 * that over-estimates human-chosen passwords. Printing `28.31` would claim a precision the
 * method does not have.
 */
export function formatEntropyBits(bits: number): string {
  return bits <= 0 ? '—' : `≈${Math.round(bits)} bits`;
}

/** "3 records" / "1 record". Used often enough that three call sites disagreed without it. */
export function countLabel(count: number, noun = 'record'): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
