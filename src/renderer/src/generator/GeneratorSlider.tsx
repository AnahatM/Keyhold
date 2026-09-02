// SPDX-License-Identifier: GPL-3.0-or-later
import { useId } from 'react';
import type { GeneratorRange } from '@shared/model/generator.js';
import { clampToRange } from './generator-options.js';

/**
 * The one numeric control the generator needs.
 *
 * `min` and `max` are **props, not literals** — they arrive from `generator.limits()` and
 * are the engine's own `GENERATOR_LIMITS`. A `min={8}` typed in here would be a second
 * list, and it would disagree with the engine the first time either changed.
 *
 * A range input rather than a number field, because a number field bound to state fights
 * the person typing into it: clamping "1" up to the minimum on the way to "16" makes the
 * larger value unreachable. A range is precise enough with the arrow keys (one step),
 * Page Up/Down (a jump) and Home/End (the bounds), all of which browsers give for free.
 *
 * The visible number is `aria-hidden`: the input already reports it through
 * `aria-valuetext`, and a live-region duplicate would announce every step of a drag.
 */

export interface GeneratorSliderProps {
  readonly label: string;
  readonly value: number;
  readonly range: GeneratorRange;
  /** The noun the value counts, for the spoken value: "characters", "words", "digits". */
  readonly unit: string;
  readonly onChange: (value: number) => void;
}

export function GeneratorSlider({
  label,
  value,
  range,
  unit,
  onChange,
}: GeneratorSliderProps): React.JSX.Element {
  const id = useId();

  return (
    <div className="kh-gen-slider">
      <label className="kh-gen-slider__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="kh-gen-slider__input"
        type="range"
        min={range.min}
        max={range.max}
        step={1}
        value={value}
        aria-valuetext={`${value} ${unit}`}
        onChange={(event) => {
          onChange(clampToRange(event.target.valueAsNumber, range));
        }}
      />
      <span className="kh-gen-slider__value" aria-hidden="true">
        {value}
      </span>
    </div>
  );
}
