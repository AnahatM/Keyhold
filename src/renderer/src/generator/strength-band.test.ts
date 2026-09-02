// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DEFAULT_HEALTH_THRESHOLDS } from '@shared/model/health.js';
import {
  METER_CEILING_BITS,
  STRENGTH_BANDS,
  bandForEntropyBits,
  formatBits,
  meterPercent,
} from './strength-band.js';

/**
 * The banding is the one place this UI could quietly start lying.
 *
 * A generator that called 55 bits "strong" would still pass every other test in this
 * project — the number crossing the bridge would be correct, and only the word beside it
 * would be wrong. So the assertions below are about honesty, not arithmetic.
 */

describe('bandForEntropyBits', () => {
  it('agrees with the health dashboard about where "weak" ends', () => {
    // The single most important assertion in this file. If the generator and the health
    // screen disagree, the same password is "fair" in one place and flagged in the other.
    const weakCeiling = DEFAULT_HEALTH_THRESHOLDS.weakEntropyBits;
    expect(bandForEntropyBits(weakCeiling - 0.01).id).toBe('weak');
    expect(bandForEntropyBits(weakCeiling).id).toBe('fair');
  });

  it('never calls a short PIN anything but very weak', () => {
    // Four digits is 13.29 bits. The engine reports it plainly; so must the word.
    expect(bandForEntropyBits(4 * Math.log2(10)).id).toBe('very-weak');
    expect(bandForEntropyBits(6 * Math.log2(10)).id).toBe('very-weak');
  });

  it('rates the engine’s own defaults as it should', () => {
    // 20 random characters over the 94-character alphabet ≈ 131 bits; six EFF words ≈ 77.5.
    expect(bandForEntropyBits(20 * Math.log2(94)).id).toBe('excellent');
    expect(bandForEntropyBits(6 * Math.log2(7776)).id).toBe('fair');
  });

  it('is monotonic — more bits never means a weaker word', () => {
    let previous = -1;
    for (let bits = 0; bits <= 200; bits += 0.5) {
      const index = STRENGTH_BANDS.indexOf(bandForEntropyBits(bits));
      expect(index).toBeGreaterThanOrEqual(previous);
      previous = index;
    }
  });

  it('survives a broken estimate instead of taking the panel down', () => {
    expect(bandForEntropyBits(-1).id).toBe('very-weak');
    expect(bandForEntropyBits(Number.NaN).id).toBe('very-weak');
  });
});

describe('the band table', () => {
  it('is ascending, and starts at zero so every figure lands somewhere', () => {
    expect(STRENGTH_BANDS[0]?.floorBits).toBe(0);
    for (let index = 1; index < STRENGTH_BANDS.length; index += 1) {
      const previous = STRENGTH_BANDS[index - 1];
      const current = STRENGTH_BANDS[index];
      expect(current?.floorBits).toBeGreaterThan(previous?.floorBits ?? 0);
    }
  });

  it('gives every band a word and a glyph, so status is never carried by colour alone', () => {
    // WCAG 1.4.1. A tone with no label is a red bar and nothing else to a colour-blind user.
    for (const band of STRENGTH_BANDS) {
      expect(band.label).not.toBe('');
      expect(band.symbol).not.toBe('');
      expect(band.meaning).not.toBe('');
    }
  });

  it('never promises a crack time', () => {
    // The engine's doc is explicit that entropy is the size of the search space, not a
    // prediction about anyone's hardware. Copy that implies otherwise is the failure mode.
    const forbidden = /\b(year|month|week|day|hour|minute|second|centur|millenni|forever)/i;
    for (const band of STRENGTH_BANDS) {
      expect(band.meaning).not.toMatch(forbidden);
    }
  });

  it('says "unbreakable" nowhere', () => {
    const overstated = /\b(unbreakable|uncrackable|impossible|guaranteed|100% safe)\b/i;
    for (const band of STRENGTH_BANDS) {
      expect(band.meaning).not.toMatch(overstated);
      expect(band.label).not.toMatch(overstated);
    }
  });
});

describe('the meter', () => {
  it('is empty at nothing and full at the ceiling', () => {
    expect(meterPercent(0)).toBe(0);
    expect(meterPercent(METER_CEILING_BITS)).toBe(100);
  });

  it('is clamped rather than overflowing its track', () => {
    expect(meterPercent(METER_CEILING_BITS * 4)).toBe(100);
    expect(meterPercent(-5)).toBe(0);
    expect(meterPercent(Number.NaN)).toBe(0);
  });

  it('moves in proportion between the two', () => {
    expect(meterPercent(METER_CEILING_BITS / 2)).toBeCloseTo(50, 6);
  });
});

describe('formatBits', () => {
  it('shows one decimal — enough to see a slider move, not enough to imply false precision', () => {
    expect(formatBits(77.549)).toBe('77.5');
    expect(formatBits(131.0)).toBe('131.0');
  });

  it('renders a broken figure as a dash rather than "NaN"', () => {
    expect(formatBits(Number.NaN)).toBe('—');
    expect(formatBits(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
