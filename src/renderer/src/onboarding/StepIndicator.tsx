// SPDX-License-Identifier: GPL-3.0-or-later
import { ONBOARDING_STEPS, stepIndex, type OnboardingStepId } from './onboarding-steps.js';
import './onboarding.css';

/**
 * Where you are, and how much is left.
 *
 * A first-run flow with no visible end is a flow people abandon: the question everyone has
 * on step two is "how long is this going to take", and answering it up front is most of
 * what makes the friction on the master-password step acceptable.
 *
 * Marked up as an ordered list rather than a row of divs, so it is a list to a screen
 * reader too, with `aria-current="step"` on the one being worked on. State is carried by a
 * tick, a number and a word — never by colour alone (WCAG 1.4.1) — and the "done" and
 * "optional" facts are also spelled out in visually hidden text, because a tick that is
 * only a tick is only a tick.
 *
 * No live region here. Focus already moves to the step's heading on every transition, and
 * announcing the same change twice is worse than announcing it once.
 */
export function StepIndicator({
  currentStepId,
}: {
  readonly currentStepId: OnboardingStepId;
}): React.JSX.Element {
  const current = stepIndex(currentStepId);

  return (
    <nav className="kh-onb__steps" aria-label="Setup progress">
      <ol className="kh-onb__steps-list">
        {ONBOARDING_STEPS.map((step, index) => {
          const state = index < current ? 'done' : index === current ? 'current' : 'todo';

          return (
            <li
              key={step.id}
              className={`kh-onb__step kh-onb__step--${state}`}
              aria-current={index === current ? 'step' : undefined}
            >
              <span className="kh-onb__step-mark" aria-hidden="true">
                {index < current ? '✓' : index + 1}
              </span>
              <span className="kh-onb__step-label">{step.shortLabel}</span>
              <span className="kh-visually-hidden">
                {index < current ? ' — done' : ''}
                {index === current ? ` — step ${index + 1} of ${ONBOARDING_STEPS.length}` : ''}
                {step.optional ? ' — optional' : ''}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
