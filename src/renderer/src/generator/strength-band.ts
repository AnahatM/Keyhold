// SPDX-License-Identifier: GPL-3.0-or-later
import { DEFAULT_HEALTH_THRESHOLDS } from '@shared/model/health.js';
import type { StatusTone } from '../components/Feedback.js';

/**
 * Turning a number of bits into a word, without overstating what the number means.
 *
 * `entropyBits` is a statement about the size of the search space the *configuration*
 * defines — how many candidates an attacker must enumerate — and nothing more. It is not a
 * crack time, because a crack time depends on a hash, a budget and a decade, none of which
 * this app knows. So the bands below say what the size of the space is and roughly what
 * that buys, and stop there.
 *
 * Two things this file deliberately does not do:
 *
 * **It does not invent a second "weak" threshold.** The boundary between weak and fair is
 * `DEFAULT_HEALTH_THRESHOLDS.weakEntropyBits`, the same number the health dashboard uses to
 * flag a stored password. A generator that called 55 bits "fair" while the health screen
 * called the same password "weak" would be two lists disagreeing in front of the user.
 *
 * **It does not re-derive entropy.** The figure always comes from the engine, over
 * `generator.estimate`. Computing it here would be a second implementation of the maths the
 * engine's tests guard, and the two would drift.
 */

export type StrengthBandId = 'very-weak' | 'weak' | 'fair' | 'strong' | 'excellent';

export interface StrengthBand {
  readonly id: StrengthBandId;
  /** The word. Status is never carried by colour alone — WCAG 1.4.1. */
  readonly label: string;
  /** A glyph shown beside the word, for the same reason. */
  readonly symbol: string;
  readonly tone: StatusTone;
  /** Plain English: roughly what a space this size is worth. */
  readonly meaning: string;
  /** Inclusive lower bound, in bits. */
  readonly floorBits: number;
}

/** Below this, the space is small enough that purpose-built hardware walks it. */
const VERY_WEAK_CEILING_BITS = 40;

/** The health dashboard's own line. Read, never restated. */
const WEAK_CEILING_BITS = DEFAULT_HEALTH_THRESHOLDS.weakEntropyBits;

/** Past this, an offline search stops being something a person can buy their way through. */
const STRONG_FLOOR_BITS = 80;

/** Past this, extra bits buy nothing anyone can measure. */
const EXCELLENT_FLOOR_BITS = 100;

/**
 * How much of the meter a configuration fills.
 *
 * 128 bits is the ceiling because it is the point past which the bar would only ever be
 * full: a 20-character random password is already ~131 bits, and a meter that is pinned for
 * every sensible setting tells the user nothing about the settings they are changing.
 */
export const METER_CEILING_BITS = 128;

/** Ascending by `floorBits`. The lookup below depends on that order. */
export const STRENGTH_BANDS: readonly StrengthBand[] = [
  {
    id: 'very-weak',
    label: 'Very weak',
    symbol: '✕',
    tone: 'danger',
    meaning: `Under 2^${VERY_WEAK_CEILING_BITS} possibilities. Hardware built for guessing walks a space this size, so treat it as a code rather than a password.`,
    floorBits: 0,
  },
  {
    id: 'weak',
    label: 'Weak',
    symbol: '!',
    tone: 'danger',
    meaning: `Keyhold's health check flags anything below ${WEAK_CEILING_BITS} bits as weak. Reasonable for a door code; not for an account that matters.`,
    floorBits: VERY_WEAK_CEILING_BITS,
  },
  {
    id: 'fair',
    label: 'Fair',
    symbol: '!',
    tone: 'warning',
    meaning:
      'Past the point where offline guessing is cheap, but not by a wide margin. Add length if nothing is going to make you type this.',
    floorBits: WEAK_CEILING_BITS,
  },
  {
    id: 'strong',
    label: 'Strong',
    symbol: '✓',
    tone: 'success',
    meaning:
      'Beyond what an offline attacker can enumerate with hardware anyone can buy. Comfortable for any account.',
    floorBits: STRONG_FLOOR_BITS,
  },
  {
    id: 'excellent',
    label: 'Excellent',
    symbol: '✓',
    tone: 'success',
    meaning:
      'Far beyond any feasible offline search. Extra bits past here buy nothing you could measure.',
    floorBits: EXCELLENT_FLOOR_BITS,
  },
];

/**
 * The band a figure falls in.
 *
 * Searched from the top down so the highest matching floor wins, which keeps the boundaries
 * inclusive-below and means a new band can be inserted without touching the lookup. A
 * negative or `NaN` figure lands in the lowest band rather than throwing: a broken estimate
 * must not take the panel down with it.
 */
export function bandForEntropyBits(bits: number): StrengthBand {
  for (let index = STRENGTH_BANDS.length - 1; index >= 0; index -= 1) {
    const band = STRENGTH_BANDS[index];
    if (band !== undefined && bits >= band.floorBits) return band;
  }
  // `noUncheckedIndexedAccess` means the loop cannot prove it found one. The array is a
  // module constant with a zero floor, so this is unreachable in practice.
  return {
    id: 'very-weak',
    label: 'Very weak',
    symbol: '✕',
    tone: 'danger',
    meaning: 'This configuration could not be measured.',
    floorBits: 0,
  };
}

/** One decimal place: enough to see a slider move, not enough to imply false precision. */
export function formatBits(bits: number): string {
  if (!Number.isFinite(bits)) return '—';
  return bits.toFixed(1);
}

/** Where the meter's fill sits, as a percentage of {@link METER_CEILING_BITS}. */
export function meterPercent(bits: number): number {
  if (!Number.isFinite(bits) || bits <= 0) return 0;
  return Math.min(100, (bits / METER_CEILING_BITS) * 100);
}
