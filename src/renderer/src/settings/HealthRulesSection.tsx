// SPDX-License-Identifier: GPL-3.0-or-later
import { useId } from 'react';
import {
  HEALTH_RULE_SEVERITY,
  HEALTH_RULE_WEIGHTS,
  type HealthRuleId,
} from '@shared/model/health.js';
import type { ConfigurableVaultSettings } from '@shared/model/settings-plan.js';
import { Badge } from '../components/Feedback.js';
import {
  RULES_BY_IMPACT,
  RULE_DESCRIPTIONS,
  RULE_LABELS,
  SEVERITY_LABELS,
  SEVERITY_ICONS,
  SEVERITY_TONES,
} from '../health/health-presentation.js';
import { SettingSelect, SettingsSection, ScopeBadge } from './SettingControls.js';
import {
  EXPIRING_WITHIN_CHOICES,
  PASSWORD_AGE_CHOICES,
  SETTING_COPY,
  WEAK_ENTROPY_CHOICES,
  vaultWeakenings,
} from './settings-copy.js';
import type { SettingsController } from './use-settings.js';
import { Icon } from '../components/Icon.js';

/**
 * Which health checks run, and where their thresholds sit.
 *
 * **The rule list is generated from `RULES_BY_IMPACT`, never typed out.** That is the whole
 * reason this file is short: a rule added to `HEALTH_RULE_IDS` gets a switch here
 * automatically, and — because `RULE_LABELS` and `RULE_DESCRIPTIONS` are exhaustive
 * `Record`s — it cannot be added without a label either. A hand-written list would let a
 * new rule ship silently unconfigurable, which is the exact failure decision D10 exists to
 * prevent: the user decides their own trade-off, and they cannot decide about a rule they
 * cannot see.
 *
 * Ordered by impact rather than alphabetically, and each rule shows its weight, because a
 * score whose arithmetic is hidden is a horoscope. Someone switching off "reused" should
 * see that they are switching off the thirty-point rule.
 *
 * The thresholds are vault-scoped alongside `passwordAgeWarningDays`, which already lives
 * inside the file. Splitting three thresholds across two scopes would produce exactly the
 * confusion this screen exists to remove.
 */

export interface HealthRulesSectionProps {
  readonly controller: SettingsController;
  readonly vault: ConfigurableVaultSettings;
}

export function HealthRulesSection({
  controller,
  vault,
}: HealthRulesSectionProps): React.JSX.Element {
  const weakened = vaultWeakenings(vault, null);
  const base = useId();
  const rulesHelpId = `${base}-rules-help`;
  const rulesTradeOffId = `${base}-rules-tradeoff`;
  const anyDisabled = weakened.has('health.rules');

  const setRule = (rule: HealthRuleId, enabled: boolean): void => {
    controller.updateVault(
      {
        health: {
          ...vault.health,
          enabledRules: { ...vault.health.enabledRules, [rule]: enabled },
        },
      },
      `${RULE_LABELS[rule]} check ${enabled ? 'on' : 'off'}.`
    );
  };

  return (
    <SettingsSection
      id="kh-settings-health"
      title="Health rules"
      description="Which problems the health dashboard looks for, and how strict it is about them. Turning a check off only stops it being reported — it never raises the score of a vault that was breaking that rule."
    >
      <p className="kh-settings-section__scope">
        <ScopeBadge scope="vault" /> Everything in this section
      </p>

      <fieldset className="kh-fieldset" aria-describedby={`${rulesHelpId} ${rulesTradeOffId}`}>
        <legend className="kh-fieldset__legend">
          {SETTING_COPY['health.rules'].label}
          <ScopeBadge scope="vault" />
        </legend>

        <p id={rulesHelpId} className="kh-setting__help">
          {SETTING_COPY['health.rules'].help}
        </p>

        <p
          id={rulesTradeOffId}
          className={`kh-tradeoff${anyDisabled ? ' kh-tradeoff--active' : ''}`}
        >
          <span className="kh-tradeoff__symbol" aria-hidden="true">
            <Icon name={anyDisabled ? 'warning' : 'info'} size="sm" />
          </span>
          <span className="kh-tradeoff__label">{anyDisabled ? 'In effect:' : 'Trade-off:'}</span>{' '}
          {SETTING_COPY['health.rules'].tradeOff}
        </p>

        <ul className="kh-rule-list">
          {RULES_BY_IMPACT.map((rule) => {
            const id = `${base}-rule-${rule}`;
            const descriptionId = `${id}-description`;
            const severity = HEALTH_RULE_SEVERITY[rule];
            const enabled = vault.health.enabledRules[rule];

            return (
              <li key={rule} className="kh-rule">
                <input
                  type="checkbox"
                  id={id}
                  className="kh-rule__input"
                  checked={enabled}
                  disabled={controller.busy}
                  aria-describedby={descriptionId}
                  onChange={(event) => {
                    setRule(rule, event.target.checked);
                  }}
                />
                <div className="kh-rule__body">
                  <label htmlFor={id} className="kh-rule__label">
                    {RULE_LABELS[rule]}
                  </label>
                  <Badge tone={SEVERITY_TONES[severity]} symbol={SEVERITY_ICONS[severity]}>
                    {SEVERITY_LABELS[severity]}
                  </Badge>
                  {/* The weight, so switching off a check is a decision with a visible size
                      rather than a shrug. */}
                  <span className="kh-rule__weight">−{HEALTH_RULE_WEIGHTS[rule]} points</span>
                  <p id={descriptionId} className="kh-rule__description">
                    {RULE_DESCRIPTIONS[rule]}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <fieldset className="kh-fieldset">
        <legend className="kh-fieldset__legend">Thresholds</legend>

        <SettingSelect
          settingId="health.weakEntropyBits"
          choices={WEAK_ENTROPY_CHOICES}
          value={vault.health.weakEntropyBits}
          tradeOffActive={weakened.has('health.weakEntropyBits')}
          onChange={(weakEntropyBits) => {
            controller.updateVault(
              { health: { ...vault.health, weakEntropyBits } },
              `Passwords below ${weakEntropyBits} bits will be called weak.`
            );
          }}
        />

        <SettingSelect
          settingId="passwordAgeWarningDays"
          choices={PASSWORD_AGE_CHOICES}
          value={vault.passwordAgeWarningDays}
          onChange={(passwordAgeWarningDays) => {
            controller.updateVault(
              { passwordAgeWarningDays },
              `Passwords will be called old after ${passwordAgeWarningDays} days.`
            );
          }}
        />

        <SettingSelect
          settingId="health.expiringWithinDays"
          choices={EXPIRING_WITHIN_CHOICES}
          value={vault.health.expiringWithinDays}
          onChange={(expiringWithinDays) => {
            controller.updateVault(
              { health: { ...vault.health, expiringWithinDays } },
              `Warning ${expiringWithinDays} days before a rotation date.`
            );
          }}
        />
      </fieldset>
    </SettingsSection>
  );
}
