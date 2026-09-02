// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  HEALTH_RULE_IDS,
  HEALTH_RULE_WEIGHTS,
  MAX_PENALTY_PER_RECORD,
  type VaultHealthReport,
} from '@shared/model/health.js';
import { buildReport } from './health-fixture.js';
import {
  BEST_ACHIEVABLE_SCORE,
  WORST_ACHIEVABLE_SCORE,
  WORST_COMPATIBLE_RULES,
  WORST_RECORD_PENALTY,
  explainScore,
  scoreBand,
} from './health-score.js';

/**
 * The score, re-derived.
 *
 * The engine's own tests prove `score === round(100 − Σ penalty / analysedCount)` on the main
 * side. These prove the renderer's re-derivation of it agrees, using fixtures built with the
 * engine's arithmetic — so if either side's formula moves, one of the two suites fails rather
 * than the dashboard quietly showing working that does not match its own number.
 *
 * Fault injections performed, all caught and all reverted. Counts are the failures in this
 * file; the same injections also broke assertions elsewhere, noted in those files:
 *
 *   | Injection                                               | Result                      |
 *   |---------------------------------------------------------|-----------------------------|
 *   | `chargedPoints` computed from `rawPoints` (cap ignored)  | 1 failed — "reports the per-record cap as its own adjustment": `expected 107 to be 100` |
 *   | `RULES_BY_IMPACT` sorted alphabetically                  | 1 failed — the attribution order: `expected [ 'emptyTitle', 'reused' ] to deeply equal [ 'reused', 'emptyTitle' ]` |
 */

describe('reproducing the score', () => {
  it('agrees with the report, across a spread of vaults', () => {
    const vaults: readonly VaultHealthReport[] = [
      buildReport([{ id: 'a' }, { id: 'b' }]),
      buildReport([{ id: 'a', rules: ['weak'] }, { id: 'b' }]),
      buildReport([
        { id: 'a', rules: ['reused'], clusterId: 'reused-1' },
        { id: 'b', rules: ['reused'], clusterId: 'reused-1' },
        { id: 'c', rules: ['old', 'insecureUrl'] },
        { id: 'd' },
        { id: 'e' },
      ]),
      buildReport(
        HEALTH_RULE_IDS.map((rule, index) => ({ id: `r${index}`, rules: [rule] as const }))
      ),
    ];

    for (const report of vaults) {
      const explanation = explainScore(report);
      expect(explanation.recomputedScore, JSON.stringify(report.counts)).toBe(report.score);
      expect(explanation.reproducible).toBe(true);
    }
  });

  it('reports a mismatch rather than hiding it', () => {
    // If the arithmetic ever disagreed, the honest thing is to say the number could not be
    // verified. A dashboard that silently prefers one of two disagreeing figures is worse
    // than one that admits the disagreement.
    const report = buildReport([{ id: 'a', rules: ['weak'] }, { id: 'b' }]);
    const tampered: VaultHealthReport = { ...report, score: report.score - 5 };

    const explanation = explainScore(tampered);
    expect(explanation.reproducible).toBe(false);
    expect(explanation.score).toBe(tampered.score);
    expect(explanation.recomputedScore).toBe(report.score);
  });

  it('attributes points to rules by weight × count, heaviest first', () => {
    const report = buildReport([
      { id: 'a', rules: ['emptyTitle'] },
      { id: 'b', rules: ['reused'], clusterId: 'reused-1' },
      { id: 'c', rules: ['reused'], clusterId: 'reused-1' },
    ]);
    const explanation = explainScore(report);

    expect(explanation.lines.map((line) => line.rule)).toEqual(['reused', 'emptyTitle']);
    expect(explanation.lines[0]?.points).toBe(HEALTH_RULE_WEIGHTS.reused * 2);
    expect(explanation.lines[1]?.points).toBe(HEALTH_RULE_WEIGHTS.emptyTitle);
    expect(explanation.rawPoints).toBe(
      HEALTH_RULE_WEIGHTS.reused * 2 + HEALTH_RULE_WEIGHTS.emptyTitle
    );
    // Nothing hit the cap, so the two totals agree and no adjustment line is shown.
    expect(explanation.chargedPoints).toBe(explanation.rawPoints);
    expect(explanation.pointsRemovedByCap).toBe(0);
  });

  it('reports the per-record cap as its own adjustment rather than smearing it', () => {
    // A record breaking every rule at once cannot happen in the engine — `incomplete` needs
    // the absent password `weak` requires — so this fixture is synthetic on purpose. What is
    // being tested is the arithmetic and its presentation: the cap is applied per record and
    // cannot be attributed back to individual rules without inventing an allocation.
    const everyRule = [...HEALTH_RULE_IDS];
    const raw = everyRule.reduce((total, rule) => total + HEALTH_RULE_WEIGHTS[rule], 0);
    expect(raw).toBeGreaterThan(MAX_PENALTY_PER_RECORD);

    const report = buildReport([{ id: 'a', rules: everyRule }, { id: 'b' }]);
    const explanation = explainScore(report);

    expect(explanation.rawPoints).toBe(raw);
    expect(explanation.chargedPoints).toBe(MAX_PENALTY_PER_RECORD);
    expect(explanation.pointsRemovedByCap).toBe(raw - MAX_PENALTY_PER_RECORD);
    // And the score still reproduces, because it is built from the charged total.
    expect(explanation.reproducible).toBe(true);
  });

  it('counts records, not issues', () => {
    const report = buildReport([
      { id: 'a', rules: ['weak', 'old', 'emptyTitle'] },
      { id: 'b' },
      { id: 'c' },
    ]);
    const explanation = explainScore(report);

    expect(explanation.analysedCount).toBe(3);
    expect(explanation.flaggedRecordCount).toBe(1);
    expect(explanation.healthyCount).toBe(2);
    expect(explanation.lines).toHaveLength(3);
  });

  it('surfaces the trashed count, so the checked number is explained', () => {
    const explanation = explainScore(buildReport([{ id: 'a' }], { trashedCount: 7 }));
    expect(explanation.analysedCount).toBe(1);
    expect(explanation.trashedCount).toBe(7);
  });

  it('counts the enabled rules from the config the engine actually used', () => {
    const explanation = explainScore(
      buildReport([{ id: 'a' }], { enabledRules: { old: false, expiring: false } })
    );
    expect(explanation.totalRuleCount).toBe(HEALTH_RULE_IDS.length);
    expect(explanation.enabledRuleCount).toBe(HEALTH_RULE_IDS.length - 2);
  });
});

describe('the ends of the scale', () => {
  it('derives the worst reachable score from the weights rather than hardcoding it', () => {
    // Some rules are mutually exclusive on one record, so the floor is not 0. Deriving it
    // means a weight change moves the copy on screen instead of quietly making it a lie.
    const expected = WORST_COMPATIBLE_RULES.reduce(
      (total, rule) => total + HEALTH_RULE_WEIGHTS[rule],
      0
    );
    expect(WORST_RECORD_PENALTY).toBe(expected);
    expect(WORST_ACHIEVABLE_SCORE).toBe(100 - expected);
    // Pinned, so a weight change breaks a test rather than a paragraph of prose. The engine
    // side pins the same 99 in `src/main/health/rules.test.ts`.
    expect(WORST_RECORD_PENALTY).toBe(99);
    expect(WORST_ACHIEVABLE_SCORE).toBe(1);
  });

  it('excludes the rules that cannot fire alongside the others', () => {
    // `expiring` cannot coexist with `expired`; `incomplete` requires the very absence of the
    // password that `weak` and `reused` need.
    expect(WORST_COMPATIBLE_RULES).not.toContain('expiring');
    expect(WORST_COMPATIBLE_RULES).not.toContain('incomplete');
  });

  it('scores a vault of maximally-broken records at the derived floor, not zero', () => {
    const report = buildReport([
      { id: 'a', rules: WORST_COMPATIBLE_RULES, clusterId: 'reused-1' },
      { id: 'b', rules: WORST_COMPATIBLE_RULES, clusterId: 'reused-1' },
    ]);
    expect(report.score).toBe(WORST_ACHIEVABLE_SCORE);
    expect(explainScore(report).reproducible).toBe(true);
  });
});

describe('the band', () => {
  it('calls an empty vault unmeasured, never perfect', () => {
    // The engine returns 100 for an empty vault because reporting 0 would be a lie in the
    // alarming direction. Rendering that as "all clear" would be a lie in the other one.
    const band = scoreBand(explainScore(buildReport([])));
    expect(band.id).toBe('unmeasured');
    expect(band.tone).toBe('neutral');
    expect(band.label).not.toMatch(/clear|perfect|secure/i);
  });

  it('says what was checked rather than claiming the vault is secure', () => {
    const clear = scoreBand(explainScore(buildReport([{ id: 'a' }, { id: 'b' }])));
    expect(clear.id).toBe('clear');
    expect(clear.summary).toContain('checks');

    // Eight offline rules cannot see a phished password, a breached provider or a keylogger.
    // Saying "secure" on the strength of a green arc would be the most harmful sentence here.
    for (const band of [
      clear,
      scoreBand(explainScore(buildReport([{ id: 'a', rules: ['old'] }, { id: 'b' }]))),
      scoreBand(explainScore(buildReport([{ id: 'a', rules: ['reused', 'weak'] }]))),
    ]) {
      expect(band.summary).not.toMatch(/\b(secure|safe|protected|perfect)\b/i);
    }
  });

  it('mentions how many checks were on, so a partial all-clear is not read as a full one', () => {
    const explanation = explainScore(
      buildReport([{ id: 'a' }], { enabledRules: { old: false, weak: false, reused: false } })
    );
    expect(scoreBand(explanation).summary).toContain(`${HEALTH_RULE_IDS.length - 3} of`);
  });

  it('moves through the bands as the score falls', () => {
    const bandFor = (report: VaultHealthReport): string => scoreBand(explainScore(report)).id;

    // One `old` record in ten: 10 points over 10 records = score 99.
    expect(
      bandFor(
        buildReport([
          { id: 'a', rules: ['old'] },
          ...Array.from({ length: 9 }, (_, index) => ({ id: `r${index}` })),
        ])
      )
    ).toBe('good');

    // Half the vault reused: 30 × 2 over 4 = 15, score 85 — still "good" at the boundary.
    expect(
      bandFor(
        buildReport([
          { id: 'a', rules: ['reused'], clusterId: 'reused-1' },
          { id: 'b', rules: ['reused'], clusterId: 'reused-1' },
          { id: 'c' },
          { id: 'd' },
        ])
      )
    ).toBe('good');

    // Every record reused: score 70.
    expect(
      bandFor(
        buildReport([
          { id: 'a', rules: ['reused'], clusterId: 'reused-1' },
          { id: 'b', rules: ['reused'], clusterId: 'reused-1' },
          { id: 'c' },
        ])
      )
    ).toBe('mixed');

    expect(
      bandFor(buildReport([{ id: 'a', rules: ['reused', 'weak'], clusterId: 'reused-1' }]))
    ).toBe('poor');
  });

  it('has a distinct word for every band, so the colour is never the only signal', () => {
    const bands = [
      scoreBand(explainScore(buildReport([]))), // unmeasured
      scoreBand(explainScore(buildReport([{ id: 'a' }]))), // clear, 100
      scoreBand(explainScore(buildReport([{ id: 'a', rules: ['old'] }, { id: 'b' }]))), // good, 95
      scoreBand(
        explainScore(
          buildReport([
            { id: 'a', rules: ['reused'], clusterId: 'reused-1' },
            { id: 'b', rules: ['reused'], clusterId: 'reused-1' },
          ])
        )
      ), // mixed, 70
      scoreBand(explainScore(buildReport([{ id: 'a', rules: ['reused', 'weak'] }]))), // poor, 45
    ];

    expect(bands.map((band) => band.id)).toEqual(['unmeasured', 'clear', 'good', 'mixed', 'poor']);
    expect(new Set(bands.map((band) => band.label)).size).toBe(5);
  });
});

describe('the best achievable score', () => {
  it('is 100, and is actually reachable', () => {
    expect(BEST_ACHIEVABLE_SCORE).toBe(100);
    expect(buildReport([{ id: 'a' }, { id: 'b' }]).score).toBe(BEST_ACHIEVABLE_SCORE);
  });
});
