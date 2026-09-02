// SPDX-License-Identifier: GPL-3.0-or-later
import {
  DEFAULT_HEALTH_RULE_TOGGLES,
  HEALTH_RULE_SEVERITY,
  HEALTH_RULE_WEIGHTS,
  type HealthRuleId,
} from '@shared/model/health.js';
import { Button } from '../components/Button.js';
import {
  RULE_DESCRIPTIONS,
  RULE_LABELS,
  RULES_BY_IMPACT,
  SEVERITY_LABELS,
  SEVERITY_SYMBOLS,
} from './health-presentation.js';
import type { RuleToggles } from './use-health-report.js';

/**
 * Which checks run.
 *
 * Decision D10 — every feature ships a setting, because the user decides their own
 * security/convenience trade-off. Plenty of people want to be told a password has lapsed
 * without being nagged for the fortnight beforehand, which is exactly why `expiring` and
 * `expired` are separate rules rather than one rule with two outcomes.
 *
 * ## Presentation decisions
 *
 * **The copy states the engine's actual guarantee, and no more.** The per-record cap is not
 * renormalised to the enabled rule set, so switching a check off can only raise the score or
 * leave it — never lower it. That is a real, tested property, and it is worth saying because
 * the natural assumption is the opposite: that turning checks off is cheating.
 *
 * **Turning a check off does not fix anything, and the wording avoids implying it does.**
 * The records are still there; the dashboard just stops asking about them.
 *
 * **Each row carries what the check costs and how loud it is**, so the trade-off being made
 * is visible at the moment it is made rather than buried in a doc.
 */
export function HealthRuleToggles({
  enabledRules,
  counts,
  pending,
  onRuleEnabled,
  onReset,
}: {
  readonly enabledRules: RuleToggles;
  readonly counts: Readonly<Record<HealthRuleId, number>>;
  readonly pending: boolean;
  readonly onRuleEnabled: (rule: HealthRuleId, enabled: boolean) => void;
  readonly onReset: () => void;
}): React.JSX.Element {
  const changed = RULES_BY_IMPACT.some(
    (rule) => enabledRules[rule] !== DEFAULT_HEALTH_RULE_TOGGLES[rule]
  );

  return (
    <section className="kh-health-checks" aria-labelledby="kh-health-checks-heading">
      <div className="kh-health-checks__header">
        <h3 id="kh-health-checks-heading" className="kh-health__heading">
          Checks
        </h3>
        {changed && (
          <Button variant="ghost" size="sm" disabled={pending} onClick={onReset}>
            Turn all back on
          </Button>
        )}
      </div>

      <p className="kh-health__hint">
        Switching a check off only stops it being reported — the records themselves do not change.
        Because the scoring is not rescaled to the checks you leave on, turning one off can only
        raise the score or leave it exactly where it is.
      </p>

      <ul className="kh-health-checks__list">
        {RULES_BY_IMPACT.map((rule) => {
          const inputId = `kh-health-check-${rule}`;
          const severity = HEALTH_RULE_SEVERITY[rule];

          return (
            <li key={rule} className="kh-health-check">
              <input
                id={inputId}
                type="checkbox"
                className="kh-health-check__input"
                checked={enabledRules[rule]}
                disabled={pending}
                aria-describedby={`${inputId}-description`}
                onChange={(event) => {
                  onRuleEnabled(rule, event.currentTarget.checked);
                }}
              />
              <label htmlFor={inputId} className="kh-health-check__label">
                <span className="kh-health-check__name">{RULE_LABELS[rule]}</span>
                <span className="kh-health-check__meta">
                  <span aria-hidden="true">{SEVERITY_SYMBOLS[severity]}</span>{' '}
                  {SEVERITY_LABELS[severity]} · −{HEALTH_RULE_WEIGHTS[rule]} points ·{' '}
                  {enabledRules[rule] ? `${counts[rule]} flagged` : 'not running'}
                </span>
              </label>
              <p id={`${inputId}-description`} className="kh-health-check__description">
                {RULE_DESCRIPTIONS[rule]}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
