// SPDX-License-Identifier: GPL-3.0-or-later
import { useId, useState } from 'react';
import type { AuditPrivacyLevel } from '@shared/model/credential.js';
import type { ConfigurableVaultSettings } from '@shared/model/settings-plan.js';
import { Button } from '../components/Button.js';
import { SettingSelect, SettingSwitch, SettingsSection, ScopeBadge } from './SettingControls.js';
import {
  AUDIT_LEVELS_IN_ORDER,
  AUDIT_LEVEL_COSTS,
  AUDIT_LEVEL_TITLES,
  HISTORY_MAX_CHOICES,
  SETTING_COPY,
  auditLevelCapturesNetwork,
  auditLevelOmits,
  auditLevelRecords,
  vaultWeakenings,
} from './settings-copy.js';
import type { SettingsController } from './use-settings.js';
import { Icon } from '../components/Icon.js';

/**
 * History retention and the audit privacy level.
 *
 * This is the section that most needs real copy, because it is the one where the setting's
 * consequence is invisible: the audit level decides what gets written *inside the encrypted
 * file*, and the file is the thing people copy to a USB stick, sync to a second machine, or
 * hand to someone. A control labelled "Audit privacy: network" tells nobody that their
 * vault will name the cafés they have worked in.
 *
 * Three decisions this file exists to honour:
 *
 * **What each level records is generated, never written out.** The lists come from
 * `AUDIT_LEVEL_FIELDS` — the same table the capture code obeys — through
 * `ORIGIN_FIELD_LABELS`. A hand-written list of "what `network` records" would be a second
 * list, and the first time capture changed it would start lying to the user about the
 * contents of their own file.
 *
 * **The level is enforced at capture, so this is not a display preference.** A field this
 * setting excludes is never written, cannot be recovered by anyone holding the master
 * password, and cannot be un-hidden by a later version of Keyhold that has forgotten why
 * the setting exists. The copy says so, because otherwise "privacy level" reads like a
 * filter.
 *
 * **The network name is checkable before it is chosen.** The whole choice turns on one
 * string, and no one can weigh "the name of the network you were on" in the abstract. The
 * button asks the main process for the exact value that would be recorded right now — the
 * only honest way to present it.
 */

export interface HistoryAuditSectionProps {
  readonly controller: SettingsController;
  readonly vault: ConfigurableVaultSettings;
}

export function HistoryAuditSection({
  controller,
  vault,
}: HistoryAuditSectionProps): React.JSX.Element {
  const weakened = vaultWeakenings(vault, null);
  const groupName = useId();
  const tradeOffId = `${groupName}-tradeoff`;

  // `undefined` — not looked up yet. `null` — looked up, and there is no name to record,
  // which is a normal answer rather than a failure.
  const [networkName, setNetworkName] = useState<string | null | undefined>(undefined);
  const [checking, setChecking] = useState(false);

  const checkNetwork = (): void => {
    setChecking(true);
    void controller
      .perform('Checked the current network name.', async (gateway) => {
        const name = await gateway.networkName();
        setNetworkName(name);
        return null;
      })
      .finally(() => {
        setChecking(false);
      });
  };

  return (
    <SettingsSection
      id="kh-settings-history"
      title="History & the audit trail"
      description="What Keyhold remembers about every change you make, and how much it records about where you made it. These settings are stored inside the encrypted vault file itself."
    >
      <p className="kh-settings-section__scope">
        <ScopeBadge scope="vault" /> Everything in this section
      </p>

      <p className="kh-callout kh-callout--vault">
        <span className="kh-callout__symbol" aria-hidden="true">
          <Icon name="lock" size="lg" />
        </span>
        <span>
          <strong>These choices travel with the file.</strong> They are written inside the encrypted
          body of your vault, not into Keyhold&rsquo;s own settings. Open this vault on another
          computer and it will behave the same way — and anyone you hand a copy to gets whatever the
          audit level recorded.
        </span>
      </p>

      <fieldset className="kh-fieldset">
        <legend className="kh-fieldset__legend">History</legend>

        <SettingSwitch
          settingId="historyEnabledByDefault"
          checked={vault.historyEnabledByDefault}
          onChange={(historyEnabledByDefault) => {
            controller.updateVault(
              { historyEnabledByDefault },
              historyEnabledByDefault
                ? 'New records will keep history.'
                : 'New records will not keep history.'
            );
          }}
        />

        <SettingSelect
          settingId="historyMaxVersions"
          choices={HISTORY_MAX_CHOICES}
          value={vault.historyMaxVersions}
          onChange={(historyMaxVersions) => {
            controller.updateVault(
              { historyMaxVersions },
              historyMaxVersions === null
                ? 'Keeping every version.'
                : `Keeping ${historyMaxVersions} versions per record.`
            );
          }}
        />
      </fieldset>

      <fieldset className="kh-fieldset" aria-describedby={`${groupName}-help ${tradeOffId}`}>
        <legend className="kh-fieldset__legend">
          {SETTING_COPY.auditPrivacyLevel.label}
          <ScopeBadge scope="vault" />
        </legend>

        <p id={`${groupName}-help`} className="kh-setting__help">
          {SETTING_COPY.auditPrivacyLevel.help}
        </p>

        <p
          id={tradeOffId}
          className={`kh-tradeoff${weakened.has('auditPrivacyLevel') ? ' kh-tradeoff--active' : ''}`}
        >
          <span className="kh-tradeoff__symbol" aria-hidden="true">
            <Icon name={weakened.has('auditPrivacyLevel') ? 'warning' : 'info'} size="sm" />
          </span>
          <span className="kh-tradeoff__label">
            {weakened.has('auditPrivacyLevel') ? 'In effect:' : 'Trade-off:'}
          </span>{' '}
          {SETTING_COPY.auditPrivacyLevel.tradeOff}
        </p>

        <div className="kh-audit-levels">
          {AUDIT_LEVELS_IN_ORDER.map((level) => (
            <AuditLevelOption
              key={level}
              level={level}
              groupName={groupName}
              selected={vault.auditPrivacyLevel === level}
              disabled={controller.busy}
              onSelect={() => {
                controller.updateVault(
                  { auditPrivacyLevel: level },
                  `Each change will now record: ${auditLevelRecords(level).join(', ')}.`
                );
              }}
            />
          ))}
        </div>

        <div className="kh-network-check">
          <Button variant="secondary" size="sm" loading={checking} onClick={checkNetwork}>
            What network am I on right now?
          </Button>
          <p className="kh-network-check__result" aria-live="polite">
            {networkName === undefined
              ? 'Check before you choose — the levels that record a network write this exact string into your vault.'
              : networkName === null
                ? 'Keyhold cannot name your current network, so nothing would be recorded for it right now. That can change the moment you join a named Wi-Fi network.'
                : `Right now Keyhold would record: “${networkName}”.`}
          </p>
          {!auditLevelCapturesNetwork(vault.auditPrivacyLevel) && (
            <p className="kh-network-check__note">
              At your current level this is not recorded at all.
            </p>
          )}
        </div>
      </fieldset>
    </SettingsSection>
  );
}

/**
 * One privacy level, showing both halves of the answer.
 *
 * Both halves, deliberately: "what this records" alone leaves the reader to work out the
 * difference between levels by comparing four lists, and the question people actually have
 * is "what does this *not* write into my file". Neither list is written by hand — see the
 * file header.
 */
function AuditLevelOption({
  level,
  groupName,
  selected,
  disabled,
  onSelect,
}: {
  readonly level: AuditPrivacyLevel;
  readonly groupName: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}): React.JSX.Element {
  const id = `${groupName}-${level}`;
  const descriptionId = `${id}-description`;
  const records = auditLevelRecords(level);
  const omits = auditLevelOmits(level);
  const cost = AUDIT_LEVEL_COSTS[level];

  return (
    <div className={`kh-audit-level${selected ? ' kh-audit-level--selected' : ''}`}>
      <div className="kh-audit-level__head">
        <input
          type="radio"
          id={id}
          name={groupName}
          className="kh-audit-level__input"
          value={level}
          checked={selected}
          disabled={disabled}
          aria-describedby={descriptionId}
          onChange={onSelect}
        />
        <label htmlFor={id} className="kh-audit-level__label">
          {AUDIT_LEVEL_TITLES[level]}
          <span className="kh-audit-level__key"> ({level})</span>
        </label>
      </div>

      <div id={descriptionId} className="kh-audit-level__body">
        <p className="kh-audit-level__list">
          <span className="kh-audit-level__list-label">Records:</span> {records.join(' · ')}
        </p>
        {omits.length > 0 && (
          <p className="kh-audit-level__list">
            <span className="kh-audit-level__list-label">Never recorded:</span> {omits.join(' · ')}
          </p>
        )}
        {cost !== '' && (
          <p className="kh-audit-level__cost">
            <Icon name="warning" size="sm" /> {cost}
          </p>
        )}
      </div>
    </div>
  );
}
