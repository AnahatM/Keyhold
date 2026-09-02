// SPDX-License-Identifier: GPL-3.0-or-later
import {
  DEFAULT_HEALTH_RULE_TOGGLES,
  DEFAULT_HEALTH_THRESHOLDS,
  HEALTH_RULE_IDS,
  HEALTH_RULE_SEVERITY,
  HEALTH_RULE_WEIGHTS,
  MAX_PENALTY_PER_RECORD,
  type ClusterRuleId,
  type CredentialHealth,
  type HealthCluster,
  type HealthIssue,
  type HealthRuleId,
  type VaultHealthReport,
} from '@shared/model/health.js';

/**
 * Reports to render against, built by hand.
 *
 * The renderer cannot call `analyseVault` — that is main-process code, and importing it here
 * would be the renderer reaching across the boundary this whole feature is shaped by. So the
 * fixtures are assembled directly, using the **same arithmetic the engine uses**: penalty is
 * the sum of the broken rules' weights capped per record, and the score is 100 minus the
 * average penalty, rounded and clamped.
 *
 * That is deliberate rather than lazy. `health-score.ts` re-derives the score in the renderer
 * from data that crossed the bridge, and the only way to know the re-derivation agrees with
 * the engine is to build a report the engine's way and check that it comes back out. If the
 * engine's formula ever changes, `src/main/health/rules.test.ts` fails on the main side and
 * the guard test here fails on this side.
 *
 * Test-only. Nothing in the app imports it.
 */

export interface FixtureRecord {
  readonly id: string;
  readonly title?: string;
  readonly username?: string;
  readonly email?: string;
  /** The rules this record breaks. Order is normalised to `HEALTH_RULE_IDS`. */
  readonly rules?: readonly HealthRuleId[];
  /** Joins this record to a cluster. The rule must be a cluster rule. */
  readonly clusterId?: string;
  readonly entropyBits?: number;
  /** The non-secret hint on the issue — the offending host, for `insecureUrl`. */
  readonly detail?: string;
}

export interface FixtureOptions {
  readonly now?: number;
  readonly trashedCount?: number;
  readonly enabledRules?: Partial<Record<HealthRuleId, boolean>>;
  /** Labels per cluster id. `reused` clusters must have none — only the password is shared. */
  readonly clusterLabels?: Readonly<Record<string, string>>;
}

const RULE_ORDER = new Map(HEALTH_RULE_IDS.map((rule, index) => [rule, index]));

export function buildReport(
  records: readonly FixtureRecord[],
  options: FixtureOptions = {}
): VaultHealthReport {
  const now = options.now ?? 1_800_000_000_000;
  const enabledRules = { ...DEFAULT_HEALTH_RULE_TOGGLES, ...options.enabledRules };

  const counts = Object.fromEntries(HEALTH_RULE_IDS.map((rule) => [rule, 0])) as Record<
    HealthRuleId,
    number
  >;
  const issues: HealthIssue[] = [];
  const byCredential: CredentialHealth[] = [];
  const clusterMembers = new Map<string, string[]>();

  let totalPenalty = 0;
  let healthyCount = 0;

  for (const record of records) {
    const broken = [...(record.rules ?? [])].sort(
      (a, b) => (RULE_ORDER.get(a) ?? 0) - (RULE_ORDER.get(b) ?? 0)
    );

    if (broken.length === 0) {
      healthyCount += 1;
      continue;
    }

    const recordIssues: HealthIssue[] = broken.map((rule) => ({
      rule,
      severity: HEALTH_RULE_SEVERITY[rule],
      credentialId: record.id,
      clusterId: record.clusterId ?? null,
      detail: record.detail ?? null,
    }));

    let raw = 0;
    for (const rule of broken) {
      counts[rule] += 1;
      raw += HEALTH_RULE_WEIGHTS[rule];
    }

    const penalty = Math.min(raw, MAX_PENALTY_PER_RECORD);
    totalPenalty += penalty;
    issues.push(...recordIssues);
    byCredential.push({
      credentialId: record.id,
      issues: recordIssues,
      passwordEntropyBits: record.entropyBits ?? 0,
      penalty,
    });

    if (record.clusterId !== undefined) {
      const members = clusterMembers.get(record.clusterId) ?? [];
      members.push(record.id);
      clusterMembers.set(record.clusterId, members);
    }
  }

  const clusters: HealthCluster[] = [...clusterMembers].map(([id, credentialIds]) => ({
    id,
    rule: (id.startsWith('duplicate') ? 'duplicate' : 'reused') satisfies ClusterRuleId,
    credentialIds,
    size: credentialIds.length,
    label: options.clusterLabels?.[id] ?? null,
  }));

  const analysedCount = records.length;
  const score =
    analysedCount === 0
      ? 100
      : Math.max(0, Math.min(100, Math.round(100 - totalPenalty / analysedCount)));

  return {
    generatedAt: now,
    score,
    analysedCount,
    trashedCount: options.trashedCount ?? 0,
    healthyCount,
    counts,
    issues,
    clusters,
    byCredential,
    config: { enabledRules, thresholds: DEFAULT_HEALTH_THRESHOLDS },
  };
}
