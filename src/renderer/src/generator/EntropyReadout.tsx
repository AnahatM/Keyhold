// SPDX-License-Identifier: GPL-3.0-or-later
import { Badge } from '../components/Feedback.js';
import {
  bandForEntropyBits,
  formatBits,
  METER_CEILING_BITS,
  meterPercent,
} from './strength-band.js';

/**
 * What a configuration is worth, said honestly.
 *
 * The figure is the engine's, fetched with `generator.estimate` — the channel that prices a
 * configuration **without producing a password for it**. Dragging a slider changes this
 * readout; it does not put a stream of discarded passwords through the bridge.
 *
 * Three things this is careful about:
 *
 * **It never claims a crack time.** `entropyBits` is the size of the search space the
 * settings define, not a prediction about anyone's hardware. The band's sentence says what
 * a space that size is worth and stops there.
 *
 * **It says when the number is an upper bound.** With "require each class" on, the engine
 * subtracts an inclusion–exclusion correction and states plainly that the result is an
 * upper bound on what its sampler really achieves. That caveat is passed straight through
 * rather than rounded away.
 *
 * **The announcement is polite and settles.** The live region carries only the settled
 * figure, so a drag produces one announcement at the end rather than one per step. The
 * band is a word and a glyph as well as a colour (WCAG 1.4.1).
 */

export interface EntropyReadoutProps {
  /** `null` before the first estimate settles, or when the configuration was refused. */
  readonly bits: number | null;
  /** True while the settled figure describes settings that have since changed. */
  readonly stale: boolean;
  /** A caveat about how the figure was arrived at. Shown under the band's sentence. */
  readonly caveat?: string | undefined;
}

export function EntropyReadout({ bits, stale, caveat }: EntropyReadoutProps): React.JSX.Element {
  const band = bits === null ? null : bandForEntropyBits(bits);
  const percent = bits === null ? 0 : meterPercent(bits);
  const spoken =
    bits === null || band === null
      ? 'Measuring these settings.'
      : `About ${formatBits(bits)} bits of entropy. ${band.label}.`;

  return (
    <div className={`kh-gen-entropy${stale ? ' kh-gen-entropy--settling' : ''}`}>
      <div className="kh-gen-entropy__row">
        {band === null ? (
          <Badge tone="neutral" symbol="…">
            Measuring
          </Badge>
        ) : (
          <Badge tone={band.tone} symbol={band.symbol}>
            {band.label}
          </Badge>
        )}
        <span className="kh-gen-entropy__bits kh-secret" aria-hidden="true">
          {bits === null ? '—' : `${formatBits(bits)} bits`}
        </span>
      </div>

      {/*
       * `meter`, not `progressbar`: nothing here is progressing. A meter is a static gauge
       * within a known range, which is exactly what this is.
       */}
      <div
        className="kh-gen-entropy__track"
        role="meter"
        aria-label="Entropy of these settings"
        aria-valuenow={bits ?? 0}
        aria-valuemin={0}
        aria-valuemax={METER_CEILING_BITS}
        aria-valuetext={spoken}
      >
        <div
          className={`kh-gen-entropy__fill kh-gen-entropy__fill--${band?.tone ?? 'neutral'}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      {band !== null && <p className="kh-gen-entropy__meaning">{band.meaning}</p>}
      {caveat !== undefined && <p className="kh-gen-entropy__caveat">{caveat}</p>}

      {/*
       * Polite, and only the settled figure. Announcing mid-drag would read every
       * intermediate value of a slider to a screen-reader user.
       */}
      <span className="kh-visually-hidden" aria-live="polite">
        {stale ? '' : spoken}
      </span>
    </div>
  );
}
