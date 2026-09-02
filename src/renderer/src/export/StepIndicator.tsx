// SPDX-License-Identifier: GPL-3.0-or-later

import { EXPORT_STEPS, EXPORT_STEP_LABELS, stepIndex, type ExportStep } from './export-steps.js';
import './export.css';

/**
 * Where the user is in the export flow.
 *
 * An ordered list, because it is one: `<ol>` gives a screen reader "list, 4 items, item 2"
 * for free, which is the information a sighted user gets from the row of chips.
 *
 * `aria-current="step"` marks the current one. It is the attribute that exists for exactly
 * this, and it is what stops the indicator being a decoration — without it the only signal
 * that step two is the live one is a colour, and colour alone is never a signal here.
 * Completed steps also carry a visually hidden "completed", so the state is a word rather
 * than a tick a screen reader reads as nothing.
 */
export interface StepIndicatorProps {
  readonly current: ExportStep;
  /** Labels the list for assistive tech, and ties it to the dialog it belongs to. */
  readonly label: string;
}

export function StepIndicator({ current, label }: StepIndicatorProps): React.JSX.Element {
  const currentIndex = stepIndex(current);

  return (
    <nav aria-label={label}>
      <ol className="kh-export-steps">
        {EXPORT_STEPS.map((step, index) => {
          const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo';
          return (
            <li
              key={step}
              className={`kh-export-steps__step kh-export-steps__step--${state}`}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span className="kh-export-steps__number" aria-hidden="true">
                {state === 'done' ? '✓' : index + 1}
              </span>
              <span className="kh-export-steps__label">{EXPORT_STEP_LABELS[step]}</span>
              {state === 'done' && <span className="kh-visually-hidden">, completed</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
