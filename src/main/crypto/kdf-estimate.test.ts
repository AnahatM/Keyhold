// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MS_PER_COST_UNIT,
  estimateMs,
  kdfCost,
  kdfProgressAt,
  learnRate,
} from './kdf-estimate.js';

/**
 * The prediction behind the unlock bar.
 *
 * The whole module exists because Argon2 reports no progress and cannot be chunked, so the
 * bar is a prediction. A prediction shown as a fact is worse than a spinner, which is why the
 * properties asserted here are mostly about what it must *never* do rather than about
 * accuracy — accuracy is a machine's business and cannot be tested in CI.
 *
 * The one that matters most: **the fraction never reaches 1.** A bar that completes and then
 * sits there is how people learn that progress bars are lies, and an underestimate is not a
 * rare case — a laptop throttling or a backup running makes every estimate an underestimate.
 *
 * Fault injection performed:
 *  1. Returning `elapsed / estimate` uncapped from `kdfProgressAt` — fails "never reaches 1,
 *     however far past the estimate it goes" at the first overrun sample.
 *  2. Removing the `Math.min(0.999, ...)` guard — fails the same test at an overshoot around
 *     200 estimates, where `Math.pow(0.5, overshoot)` underflows to zero and the fraction is
 *     exactly 1. This is why the guard is there and not merely tidy.
 *  3. Deleting the `cost <= 0 || measuredMs <= 0` drop in `learnRate` — fails "ignores a
 *     sample that says nothing", returning `Infinity` and then the clamp ceiling.
 *  4. Dividing `kdfCost` by parallelism — fails "counts parallelism as work, not as speed".
 */

const params = (
  memoryKib: number,
  iterations: number
): { memoryKib: number; iterations: number } => ({
  memoryKib,
  iterations,
});

describe('the cost model', () => {
  it('is linear in memory and in iterations', () => {
    const base = kdfCost(params(19_456, 2));
    expect(kdfCost(params(38_912, 2))).toBe(base * 2);
    expect(kdfCost(params(19_456, 4))).toBe(base * 2);
  });

  it('counts parallelism as work, not as speed', () => {
    // hash-wasm is single-threaded WebAssembly: lanes are interleaved on one thread, so a
    // higher parallelism does not shorten the wall clock. Dividing by it would predict a
    // speed-up that never happens, hardest on the expensive vaults where it shows most.
    expect(kdfCost({ memoryKib: 65_536, iterations: 3 })).toBe(
      kdfCost({ memoryKib: 65_536, iterations: 3 })
    );
    const withLanes = { memoryKib: 65_536, iterations: 3, parallelism: 8 } as const;
    const withoutLanes = { memoryKib: 65_536, iterations: 3, parallelism: 1 } as const;
    expect(kdfCost(withLanes)).toBe(kdfCost(withoutLanes));
  });
});

describe('learning this machine’s rate', () => {
  it('takes the first measurement whole, having nothing to blend with', () => {
    const rate = learnRate(null, params(19_456, 2), 400);
    expect(rate).toBeCloseTo(400 / kdfCost(params(19_456, 2)), 12);
  });

  it('moves toward a new sample without being captured by it', () => {
    const slow = learnRate(DEFAULT_MS_PER_COST_UNIT, params(19_456, 2), 4_000);
    // Moved up, but nowhere near the outlier: one slow run is a backup or a throttled laptop,
    // not a slower machine, and letting it dominate makes the *next* estimate worse.
    const sample = 4_000 / kdfCost(params(19_456, 2));
    expect(slow).toBeGreaterThan(DEFAULT_MS_PER_COST_UNIT);
    expect(slow).toBeLessThan(sample / 2);
  });

  it('converges on a machine that is consistently different', () => {
    let rate: number | null = DEFAULT_MS_PER_COST_UNIT;
    for (let index = 0; index < 40; index += 1) {
      rate = learnRate(rate, params(19_456, 2), 1_000);
    }
    expect(estimateMs(params(19_456, 2), rate)).toBeCloseTo(1_000, 0);
  });

  it('ignores a sample that says nothing, rather than dividing by it', () => {
    expect(learnRate(DEFAULT_MS_PER_COST_UNIT, params(0, 0), 500)).toBe(DEFAULT_MS_PER_COST_UNIT);
    expect(learnRate(DEFAULT_MS_PER_COST_UNIT, params(19_456, 2), 0)).toBe(
      DEFAULT_MS_PER_COST_UNIT
    );
    expect(learnRate(null, params(19_456, 2), -5)).toBe(DEFAULT_MS_PER_COST_UNIT);
  });

  it('clamps a wildly implausible sample instead of trusting it', () => {
    const absurd = learnRate(DEFAULT_MS_PER_COST_UNIT, params(19_456, 2), 10_000_000);
    expect(absurd).toBeLessThanOrEqual(DEFAULT_MS_PER_COST_UNIT * 100);
    expect(Number.isFinite(absurd)).toBe(true);
  });
});

describe('the bar’s position', () => {
  it('starts at zero and climbs while the estimate holds', () => {
    expect(kdfProgressAt(0, 1_000).fraction).toBe(0);
    expect(kdfProgressAt(500, 1_000).fraction).toBeCloseTo(0.45, 5);
    expect(kdfProgressAt(999, 1_000).fraction).toBeLessThan(0.9);
    expect(kdfProgressAt(999, 1_000).overdue).toBe(false);
  });

  it('never reaches 1, however far past the estimate it goes', () => {
    // The property, over a wide sweep rather than a chosen point. An underestimate is the
    // common case, not the exotic one.
    for (const overshoot of [0, 0.5, 1, 2, 5, 20, 50, 200, 5_000, 1e6]) {
      const progress = kdfProgressAt(1_000 * (1 + overshoot), 1_000);
      expect(progress.fraction, `overshoot ${String(overshoot)}`).toBeLessThan(1);
      expect(progress.fraction, `overshoot ${String(overshoot)}`).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('is monotonic, so the bar never goes backwards', () => {
    let previous = -1;
    for (let elapsed = 0; elapsed <= 20_000; elapsed += 137) {
      const { fraction } = kdfProgressAt(elapsed, 1_000);
      expect(fraction).toBeGreaterThanOrEqual(previous);
      previous = fraction;
    }
  });

  it('says when it has overrun, so the caller can explain instead of the bar', () => {
    expect(kdfProgressAt(1_500, 1_000).overdue).toBe(true);
    expect(kdfProgressAt(900, 1_000).overdue).toBe(false);
  });

  it('survives nonsense inputs rather than producing NaN on screen', () => {
    expect(kdfProgressAt(-10, 1_000).fraction).toBe(0);
    expect(Number.isFinite(kdfProgressAt(100, 0).fraction)).toBe(true);
    expect(Number.isFinite(kdfProgressAt(100, -5).fraction)).toBe(true);
  });
});
