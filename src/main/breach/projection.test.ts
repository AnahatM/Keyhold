// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  BREACH_BAND_THRESHOLDS,
  BREACH_EXPOSURE_BANDS,
  type BreachCheckResult,
  type CredentialBreachResult,
} from '@shared/model/breach.js';
import type { BreachRunSummary } from './client.js';
import { breachExposureBand, toBreachProjection, toBreachReport } from './projection.js';

/**
 * Tests for the boundary between what the main process knows about a password and what the
 * renderer is allowed to be told about it.
 *
 * This is the same boundary the safe projection draws for records (decision D13), applied to
 * the one new fact this feature produces. The property worth guarding is short: **the exact
 * corpus count does not cross the bridge.** A count is very nearly a fingerprint — the corpus
 * holds hundreds of millions of passwords but very few of them appear *exactly* 3,861,493
 * times — so an exact count in the semi-trusted renderer would be a stable, offline-checkable
 * handle on the password itself.
 *
 * The second property is the one that decides which way a mistake goes: `safe` and `unknown`
 * are both banded `none`, so a UI that renders a band without reading the status shows
 * nothing alarming. That is the failure that is merely unhelpful, rather than the one that
 * tells somebody a password nobody checked is fine.
 */

const breached = (count: number): BreachCheckResult => ({
  status: 'breached',
  count,
  reason: null,
});

describe('banding an exposure count', () => {
  it('puts a single sighting in the lowest band, which is still a breach', () => {
    expect(breachExposureBand(breached(1))).toBe('low');
  });

  it('bands at the published thresholds, on the boundary itself', () => {
    expect(breachExposureBand(breached(BREACH_BAND_THRESHOLDS.high - 1))).toBe('low');
    expect(breachExposureBand(breached(BREACH_BAND_THRESHOLDS.high))).toBe('high');
    expect(breachExposureBand(breached(BREACH_BAND_THRESHOLDS.severe - 1))).toBe('high');
    expect(breachExposureBand(breached(BREACH_BAND_THRESHOLDS.severe))).toBe('severe');
  });

  it('bands a password that is in every cracking dictionary as severe', () => {
    expect(breachExposureBand(breached(3_861_493))).toBe('severe');
  });

  /**
   * The band alone can never be mistaken for a verdict.
   *
   * `safe` and `unknown` share a band deliberately, so the caller has to read `status` to
   * tell "checked, and clean" from "could not be checked". A UI that forgets shows nothing
   * alarming, which is the harmless direction of that mistake.
   */
  it('gives safe and unknown the same, unalarming band', () => {
    expect(breachExposureBand({ status: 'safe', count: 0, reason: null })).toBe('none');
    for (const reason of ['disabled', 'offline', 'timeout', 'rateLimited'] as const) {
      expect(breachExposureBand({ status: 'unknown', count: 0, reason })).toBe('none');
    }
  });

  it('never invents a band outside the published list', () => {
    for (const count of [0, 1, 9, 10, 99, 99_999, 100_000, Number.MAX_SAFE_INTEGER]) {
      expect(BREACH_EXPOSURE_BANDS, String(count)).toContain(breachExposureBand(breached(count)));
    }
  });
});

describe('what crosses the bridge', () => {
  const result: CredentialBreachResult = {
    credentialId: 'cred-1',
    status: 'breached',
    count: 3_861_493,
    reason: null,
  };

  it('carries the four renderer-facing fields and no others', () => {
    expect(Object.keys(toBreachProjection(result)).sort()).toEqual([
      'band',
      'credentialId',
      'reason',
      'status',
    ]);
  });

  /**
   * The assertion this file exists for.
   *
   * Written over the serialised projection rather than over its keys, because the failure
   * being guarded against is a `count` added back "just for the tooltip" — which would pass a
   * key-shape check written the obvious way and would put a near-unique fingerprint of a
   * password into the renderer.
   */
  it('does not carry the exact count, in any form', () => {
    const serialised = JSON.stringify(toBreachProjection(result));

    expect(serialised).not.toContain('3861493');
    expect(serialised).not.toContain('count');
  });

  it('keeps the reason, so the UI can say why it does not know', () => {
    const projection = toBreachProjection({
      credentialId: 'cred-2',
      status: 'unknown',
      count: 0,
      reason: 'offline',
    });

    expect(projection).toEqual({
      credentialId: 'cred-2',
      status: 'unknown',
      band: 'none',
      reason: 'offline',
    });
  });
});

describe('the whole-run report', () => {
  const summary: BreachRunSummary = {
    requestCount: 4,
    incompleteReason: 'timeout',
    results: [
      { credentialId: 'a', status: 'breached', count: 12, reason: null },
      { credentialId: 'b', status: 'breached', count: 900_000, reason: null },
      { credentialId: 'c', status: 'safe', count: 0, reason: null },
      { credentialId: 'd', status: 'unknown', count: 0, reason: 'timeout' },
      { credentialId: 'e', status: 'unknown', count: 0, reason: 'timeout' },
    ],
  };

  it('counts the three outcomes separately', () => {
    const report = toBreachReport(summary, 1_800_000_000_000);

    expect(report).toMatchObject({
      generatedAt: 1_800_000_000_000,
      checkedCount: 5,
      breachedCount: 2,
      safeCount: 1,
      unknownCount: 2,
      requestCount: 4,
      incompleteReason: 'timeout',
    });
  });

  /**
   * None of the three is derived by subtraction.
   *
   * A summary that showed "2 breached" and left the reader to assume the other three were
   * fine is exactly the conflation the three-state design exists to prevent — and it is what
   * you get for free the moment one of the counts becomes `total - the others`.
   */
  it('does not let the counts add up by assuming the rest are safe', () => {
    const report = toBreachReport(summary, 0);

    expect(report.safeCount).toBe(1);
    expect(report.safeCount + report.breachedCount).not.toBe(report.checkedCount);
    expect(report.breachedCount + report.safeCount + report.unknownCount).toBe(report.checkedCount);
  });

  it('is a pure function of its inputs and the clock it was handed', () => {
    expect(toBreachReport(summary, 1)).toEqual(toBreachReport(summary, 1));
    expect(toBreachReport(summary, 2).generatedAt).toBe(2);
  });

  it('carries no count into any of its projections', () => {
    const report = toBreachReport(summary, 0);

    expect(JSON.stringify(report.results)).not.toContain('900000');
    for (const projection of report.results) {
      expect(projection).not.toHaveProperty('count');
    }
  });

  it('reports an empty run without pretending it was a clean one', () => {
    const report = toBreachReport(
      { requestCount: 0, incompleteReason: 'disabled', results: [] },
      0
    );

    expect(report.checkedCount).toBe(0);
    expect(report.safeCount).toBe(0);
    expect(report.incompleteReason).toBe('disabled');
  });
});
