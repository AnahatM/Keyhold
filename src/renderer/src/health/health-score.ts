// SPDX-License-Identifier: GPL-3.0-or-later
import {
  HEALTH_RULE_IDS,
  HEALTH_RULE_WEIGHTS,
  MAX_PENALTY_PER_RECORD,
  type HealthRuleId,
  type VaultHealthReport,
} from '@shared/model/health.js';
import type { StatusTone } from '../components/Feedback.js';
import { RULE_LABELS, RULES_BY_IMPACT } from './health-presentation.js';

/**
 * Rebuilding the score from the report, so the dashboard can show its working.
 *
 * The engine publishes its weights and guarantees the score is reproducible from the report
 * itself — `score === round(100 − Σ penalty / analysedCount)` — precisely so a user can
 * check it. This module does the checking, in the renderer, from data that already crossed
 * the bridge. Nothing here re-derives a verdict; it re-derives the arithmetic.
 *
 * A health score that cannot be interrogated is a horoscope, and users are right to ignore
 * one. That is the whole argument for this file existing rather than the component printing
 * `report.score` and moving on.
 */

/**
 * The rules that can all fire on one record simultaneously.
 *
 * `expiring` is excluded because a password cannot be both due for rotation and past its
 * date; `incomplete` is excluded because it requires the very absence of the password that
 * `weak` and `reused` need. Declared rather than searched for, because "can these two fire
 * together?" is a fact about the rules, not something the arithmetic can deduce.
 */
export const WORST_COMPATIBLE_RULES: readonly HealthRuleId[] = [
  'reused',
  'weak',
  // Compatible with all of the above — a record can have a reused, weak, expired password and
  // no second factor at once. It is off by default, and that is deliberately not a reason to
  // leave it out: this list answers "can these fire together", which is a fact about the rules,
  // and the floor it computes has to be reachable by a user who turns the rule on rather than
  // only by one who left every default alone.
  'missingTotp',
  'expired',
  'old',
  'insecureUrl',
  'duplicate',
  'emptyTitle',
];

/** What one maximally-broken record costs. 99 with the current weights — see the guard test. */
export const WORST_RECORD_PENALTY: number = WORST_COMPATIBLE_RULES.reduce(
  (total, rule) => total + HEALTH_RULE_WEIGHTS[rule],
  0
);

/**
 * The lowest score a vault can actually reach: 1, not 0.
 *
 * Derived rather than written down, so a weight change moves the copy on screen instead of
 * quietly making it a lie. The dashboard says so out loud — promising a floor of 0 that
 * cannot be hit is the same species of dishonesty as promising a ceiling that cannot.
 */
export const WORST_ACHIEVABLE_SCORE: number = Math.max(
  0,
  100 - Math.min(WORST_RECORD_PENALTY, MAX_PENALTY_PER_RECORD)
);

export const BEST_ACHIEVABLE_SCORE = 100;

export interface ScoreLine {
  readonly rule: HealthRuleId;
  readonly label: string;
  readonly flaggedCount: number;
  readonly weight: number;
  /** `weight × flaggedCount`, before the per-record cap. */
  readonly points: number;
}

export interface ScoreExplanation {
  /** The engine's number, shown as it arrived. */
  readonly score: number;
  readonly analysedCount: number;
  readonly trashedCount: number;
  readonly healthyCount: number;
  readonly flaggedRecordCount: number;
  readonly enabledRuleCount: number;
  readonly totalRuleCount: number;
  /** One line per rule that fired, heaviest first. */
  readonly lines: readonly ScoreLine[];
  /** Σ (weight × count) across every rule — what the findings add up to on their own. */
  readonly rawPoints: number;
  /** Σ of the per-record penalties the engine actually applied, after the cap. */
  readonly chargedPoints: number;
  /** `rawPoints − chargedPoints`. Non-zero only when some record hit the cap. */
  readonly pointsRemovedByCap: number;
  readonly averagePenalty: number;
  /** The score recomputed here from `chargedPoints`. */
  readonly recomputedScore: number;
  /**
   * Whether the recomputation matched. Surfaced rather than asserted: if it ever came back
   * false the honest thing is to say the number could not be verified, not to hide it.
   */
  readonly reproducible: boolean;
  /** False for an empty vault, which is unmeasured rather than perfect. */
  readonly measured: boolean;
}

/**
 * Re-derives the score and attributes it to rules.
 *
 * Attribution uses `weight × count`, which is the raw contribution *before* the per-record
 * cap. The cap is applied per record and cannot be split back across the rules that caused
 * it without inventing an allocation, so it is reported as its own line instead of being
 * silently smeared over the others.
 */
export function explainScore(report: VaultHealthReport): ScoreExplanation {
  const lines: ScoreLine[] = [];
  let rawPoints = 0;

  for (const rule of RULES_BY_IMPACT) {
    const flaggedCount = report.counts[rule];
    const points = HEALTH_RULE_WEIGHTS[rule] * flaggedCount;
    rawPoints += points;
    if (flaggedCount === 0) continue;
    lines.push({
      rule,
      label: RULE_LABELS[rule],
      flaggedCount,
      weight: HEALTH_RULE_WEIGHTS[rule],
      points,
    });
  }

  const chargedPoints = report.byCredential.reduce((total, record) => total + record.penalty, 0);
  const measured = report.analysedCount > 0;
  const averagePenalty = measured ? chargedPoints / report.analysedCount : 0;

  // The same clamp and rounding the engine uses. Written out rather than imported because
  // `analyseVault` is main-process code the renderer must not import — so the guard test
  // pins the two together instead.
  const recomputedScore = measured
    ? Math.max(0, Math.min(100, Math.round(100 - averagePenalty)))
    : 100;

  const enabledRuleCount = HEALTH_RULE_IDS.filter(
    (rule) => report.config.enabledRules[rule]
  ).length;

  return {
    score: report.score,
    analysedCount: report.analysedCount,
    trashedCount: report.trashedCount,
    healthyCount: report.healthyCount,
    flaggedRecordCount: report.byCredential.length,
    enabledRuleCount,
    totalRuleCount: HEALTH_RULE_IDS.length,
    lines,
    rawPoints,
    chargedPoints,
    pointsRemovedByCap: rawPoints - chargedPoints,
    averagePenalty,
    recomputedScore,
    reproducible: recomputedScore === report.score,
    measured,
  };
}

export type ScoreBandId = 'unmeasured' | 'clear' | 'good' | 'mixed' | 'poor';

export interface ScoreBand {
  readonly id: ScoreBandId;
  /** A word, so the band is never carried by the arc's colour alone. */
  readonly label: string;
  readonly tone: StatusTone;
  /** One sentence, scoped to what was actually checked. */
  readonly summary: string;
}

/**
 * The word next to the number.
 *
 * Every summary is scoped to the checks that ran. "Nothing to fix" is a claim the engine can
 * support; "your vault is secure" is not — eight offline rules cannot see a phished
 * password, a breached provider or a keylogger, and saying otherwise on the strength of a
 * green arc would be the most harmful sentence in the app.
 */
export function scoreBand(explanation: ScoreExplanation): ScoreBand {
  const checks = `${explanation.enabledRuleCount} of ${explanation.totalRuleCount} checks`;

  if (!explanation.measured) {
    return {
      id: 'unmeasured',
      label: 'Nothing to check',
      tone: 'neutral',
      summary: 'This vault has no records outside the Trash, so there is nothing to score yet.',
    };
  }

  if (explanation.flaggedRecordCount === 0) {
    return {
      id: 'clear',
      label: 'All clear',
      tone: 'success',
      // Deliberately not "your vault is perfect". It is a statement about the checks.
      summary: `Nothing flagged by the ${checks} that are switched on.`,
    };
  }

  if (explanation.score >= 85) {
    return {
      id: 'good',
      label: 'Mostly healthy',
      tone: 'success',
      summary: `A few records were flagged by the ${checks} that are switched on.`,
    };
  }

  if (explanation.score >= 60) {
    return {
      id: 'mixed',
      label: 'Needs attention',
      tone: 'warning',
      summary: `Enough records were flagged to move the score. Start at the top — the list is ordered by what each finding costs.`,
    };
  }

  return {
    id: 'poor',
    label: 'Needs work',
    tone: 'danger',
    summary: `Most of this vault was flagged. Reuse and weak passwords are worth fixing first; the rest is hygiene.`,
  };
}
