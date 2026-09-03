// SPDX-License-Identifier: GPL-3.0-or-later
import type { KdfParams } from '@shared/format/types.js';

/**
 * How long an Argon2 derivation will take on *this* machine, and how far through one is.
 *
 * `CLAUDE.md` asks for determinate progress during Argon2 and calls a frozen window a bug.
 * The obstacle is that Argon2 has no progress to report: `hash-wasm` exposes one call that
 * returns when it is finished, and there is no callback to hang a percentage on. Chunking it
 * is not an option either — the whole point of the memory-hard construction is that it cannot
 * be decomposed.
 *
 * So the progress is **predicted, from a measurement of this machine**, not invented. Argon2's
 * running time is very nearly linear in `memoryKib × iterations`, and the machine's rate is
 * something we learn: every real derivation reports how long it actually took, and the stored
 * rate moves toward it. The first-ever derivation on a machine uses a shipped default and is
 * the only one that can be badly wrong; every one after it is corrected by the last.
 *
 * Two properties keep it honest rather than decorative:
 *
 *  - **It never reaches 100% before it is finished.** The curve approaches the end and stops,
 *    so an underestimate shows a bar that slows down rather than one that completes and then
 *    sits there — which is the failure that teaches people progress bars are lies.
 *  - **It says when it has overrun.** Past the estimate the caller has something to say
 *    ("this is taking longer than usual") rather than a stuck bar with no explanation.
 */

/**
 * The work in one derivation, in KiB-iterations.
 *
 * Parallelism is deliberately not divided out. It sets Argon2's lane count, and `hash-wasm`
 * is single-threaded WebAssembly — the lanes are interleaved on one thread, so raising it
 * does not make the wall clock shorter. Dividing by it would predict a speed-up that does not
 * happen, and predict it hardest on exactly the high-cost vaults where being wrong is most
 * visible.
 */
export function kdfCost(params: Pick<KdfParams, 'memoryKib' | 'iterations'>): number {
  return params.memoryKib * params.iterations;
}

/**
 * Milliseconds per KiB-iteration, before any machine has been measured.
 *
 * Taken from the OWASP floor (19 MiB × 2) completing in roughly a third of a second on an
 * unremarkable laptop. It is a starting point and nothing more: it is replaced by a real
 * measurement the first time a derivation finishes, so it is only ever visible once.
 */
export const DEFAULT_MS_PER_COST_UNIT = 333 / (19_456 * 2);

/**
 * How much of the stored rate a new measurement replaces.
 *
 * Low, on purpose. A single derivation can be slow for reasons that have nothing to do with
 * the machine — a backup running, a laptop throttling, the app cold-starting — and letting one
 * of those dominate would make the next estimate worse, not better. Slow to move means the
 * rate tracks the machine rather than the moment.
 */
const SMOOTHING = 0.25;

/** Floors and ceilings on the learned rate, so one absurd sample cannot poison the estimate. */
const MIN_MS_PER_COST_UNIT = DEFAULT_MS_PER_COST_UNIT / 100;
const MAX_MS_PER_COST_UNIT = DEFAULT_MS_PER_COST_UNIT * 100;

/**
 * Folds a completed derivation into the stored rate.
 *
 * Returns the new rate rather than mutating anything: the caller owns where it is kept, which
 * is machine preferences, and a pure function here is what makes the smoothing testable.
 */
export function learnRate(
  currentMsPerCostUnit: number | null,
  params: Pick<KdfParams, 'memoryKib' | 'iterations'>,
  measuredMs: number
): number {
  const cost = kdfCost(params);
  // A zero-cost or instant sample says nothing about the machine and would divide by zero or
  // drag the rate to the floor. Dropped rather than clamped — there is no information in it.
  if (cost <= 0 || measuredMs <= 0) return currentMsPerCostUnit ?? DEFAULT_MS_PER_COST_UNIT;

  const sample = measuredMs / cost;
  const blended =
    currentMsPerCostUnit === null
      ? sample
      : currentMsPerCostUnit * (1 - SMOOTHING) + sample * SMOOTHING;

  return Math.min(MAX_MS_PER_COST_UNIT, Math.max(MIN_MS_PER_COST_UNIT, blended));
}

/** How long a derivation with these parameters should take, given what this machine has shown. */
export function estimateMs(
  params: Pick<KdfParams, 'memoryKib' | 'iterations'>,
  msPerCostUnit: number | null
): number {
  const rate = msPerCostUnit ?? DEFAULT_MS_PER_COST_UNIT;
  // At least one tick's worth, so a caller never divides by zero working out a fraction.
  return Math.max(1, kdfCost(params) * rate);
}

/** Where the bar stops climbing on its own. The remaining tenth belongs to actually finishing. */
const CEILING = 0.9;

export interface KdfProgress {
  /** 0 to `CEILING` while running. Never 1 — completion is reported by the work ending. */
  readonly fraction: number;
  readonly elapsedMs: number;
  readonly estimatedMs: number;
  /** Past the estimate: the caller should explain rather than let a stuck bar do the talking. */
  readonly overdue: boolean;
}

/**
 * The bar's position after `elapsedMs`.
 *
 * Linear up to the estimate and asymptotic after it. The linear part is the honest one — the
 * prediction is linear in cost, so while it holds, so is the progress. The tail exists because
 * the prediction is a prediction: it keeps the bar moving, visibly slower, without ever
 * arriving, so an underestimate degrades into "nearly there" rather than into a bar that
 * completed a while ago and is still sitting there.
 */
export function kdfProgressAt(elapsedMs: number, estimatedMs: number): KdfProgress {
  const estimate = Math.max(1, estimatedMs);
  const elapsed = Math.max(0, elapsedMs);

  if (elapsed < estimate) {
    return {
      fraction: CEILING * (elapsed / estimate),
      elapsedMs: elapsed,
      estimatedMs: estimate,
      overdue: false,
    };
  }

  // Halves the remaining tenth for every further estimate's worth of waiting.
  const overshoot = (elapsed - estimate) / estimate;
  const fraction = 1 - (1 - CEILING) * Math.pow(0.5, overshoot);

  return {
    // Guarded rather than trusted: `Math.pow` with a huge overshoot underflows to zero, and
    // a bar that reads 100% while still working is the exact lie this module exists to avoid.
    fraction: Math.min(0.999, fraction),
    elapsedMs: elapsed,
    estimatedMs: estimate,
    overdue: true,
  };
}
