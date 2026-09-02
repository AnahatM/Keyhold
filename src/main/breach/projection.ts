// SPDX-License-Identifier: GPL-3.0-or-later
import {
  BREACH_BAND_THRESHOLDS,
  type BreachCheckResult,
  type BreachExposureBand,
  type BreachProjection,
  type BreachReport,
  type CredentialBreachResult,
} from '@shared/model/breach.js';
import type { BreachRunSummary } from './client.js';

/**
 * The boundary between "what the main process knows about a password" and "what the
 * renderer is allowed to be told about it".
 *
 * This is the same boundary the safe projection draws for records and the health report
 * draws for issues (decision D13), applied to the one new fact this feature produces: how
 * many times a password appears in the Pwned Passwords corpus.
 *
 * ## Why the exact count does not cross
 *
 * Because it is very nearly a fingerprint. The corpus holds hundreds of millions of
 * passwords but the counts are long-tailed and mostly distinct: knowing a password appears
 * **exactly** 3,861,493 times narrows it to a handful of candidates, and often to one. That
 * would put a stable, offline-checkable handle on a password into the semi-trusted renderer
 * — the same hazard that made health cluster ids synthetic counters instead of hashes.
 *
 * A four-value band gives up nothing the user needs. "Change this now" versus "change this"
 * is the entire actionable content of a count, and it survives the reduction intact, while
 * `severe` covers tens of millions of candidate passwords and identifies none of them.
 *
 * This file is where that reduction happens, and it is the only path by which a breach
 * result should reach the IPC layer.
 */

/**
 * The band for a result.
 *
 * `safe` and `unknown` are both `none`, and the caller must read `status` to tell them
 * apart — a band alone can never be mistaken for a verdict. Deliberate: if the UI renders
 * a band without checking the status it shows nothing alarming, which is the failure that
 * is merely unhelpful rather than the one that is dangerous.
 */
export function breachExposureBand(result: BreachCheckResult): BreachExposureBand {
  if (result.status !== 'breached') return 'none';
  if (result.count >= BREACH_BAND_THRESHOLDS.severe) return 'severe';
  if (result.count >= BREACH_BAND_THRESHOLDS.high) return 'high';
  return 'low';
}

/** One record's result, reduced to what may cross the bridge. The count does not survive. */
export function toBreachProjection(result: CredentialBreachResult): BreachProjection {
  return {
    credentialId: result.credentialId,
    status: result.status,
    band: breachExposureBand(result),
    reason: result.reason,
  };
}

/**
 * A whole run, reduced to the report the dashboard renders.
 *
 * `now` is a parameter for the same reason it is one in the health rules: a report should be
 * a pure function of its inputs, so a test can assert its contents without owning the clock.
 *
 * The three counts are reported separately and none of them is derived by subtraction. A
 * summary that showed "2 breached" and left the reader to assume the rest were fine is
 * exactly the conflation the three-state design exists to prevent.
 */
export function toBreachReport(summary: BreachRunSummary, now: number): BreachReport {
  let breachedCount = 0;
  let safeCount = 0;
  let unknownCount = 0;

  for (const result of summary.results) {
    if (result.status === 'breached') breachedCount += 1;
    else if (result.status === 'safe') safeCount += 1;
    else unknownCount += 1;
  }

  return {
    generatedAt: now,
    checkedCount: summary.results.length,
    breachedCount,
    safeCount,
    unknownCount,
    requestCount: summary.requestCount,
    incompleteReason: summary.incompleteReason,
    results: summary.results.map(toBreachProjection),
  };
}
