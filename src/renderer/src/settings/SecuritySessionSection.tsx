// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import type { MachineSettings, QuickUnlockSummary } from '@shared/model/settings-plan.js';
import { Button } from '../components/Button.js';
import { ConfirmDialog } from '../chrome/index.js';
import { SettingSelect, SettingSwitch, SettingsSection, ScopeBadge } from './SettingControls.js';
import {
  CLIPBOARD_CHOICES,
  GRANT_TTL_CHOICES,
  IDLE_MINUTE_CHOICES,
  REVEAL_LIMIT_CHOICES,
  SETTING_COPY,
  WIPE_CHOICES,
  machineWeakenings,
} from './settings-copy.js';
import type { SettingsController } from './use-settings.js';

/**
 * Locking, the clipboard, quick unlock, and the reveal ceiling.
 *
 * Every setting in here is **machine-scoped** — it lives in `preferences.json` beside the
 * app, not inside the vault — which is why the section says so once at the top as well as
 * on each row. Carrying a vault to another computer must not import your idle timeout.
 *
 * Three pieces of copy in this file are deliberate and should not be softened:
 *
 * **The quick-unlock description is rendered verbatim from the main process.** It is
 * generated per platform, and the distinction it draws is real: macOS Touch ID is a
 * biometric gate, Windows DPAPI is not — it ties the stored key to the Windows account,
 * which does nothing against someone already sitting at an unlocked session. Rewriting
 * that sentence here as "protected by biometrics" would lead someone to enable it in a
 * threat model where it does not hold. See `src/main/session/quick-unlock.ts`.
 *
 * **Wipe-after-failures asks before it is switched on, not after.** It is the one setting
 * on this screen whose looser direction destroys data rather than exposing it, and a
 * forgotten password or a child at the keyboard is enough to trigger it.
 *
 * **The reveal limit is described as a tripwire, not a defence.** It cannot stop a patient
 * attacker — anything can wait out a window — and saying otherwise would be the kind of
 * overstatement this project avoids everywhere else.
 */

export interface SecuritySessionSectionProps {
  readonly controller: SettingsController;
  readonly machine: MachineSettings;
  readonly quickUnlock: QuickUnlockSummary;
  readonly hasVault: boolean;
}

export function SecuritySessionSection({
  controller,
  machine,
  quickUnlock,
  hasVault,
}: SecuritySessionSectionProps): React.JSX.Element {
  const weakened = machineWeakenings(machine);
  const [pendingWipe, setPendingWipe] = useState<number | null>(null);

  const setAutoLock = (patch: Partial<MachineSettings['autoLock']>, announce: string): void => {
    controller.updateMachine({ autoLock: { ...machine.autoLock, ...patch } }, announce);
  };

  return (
    <SettingsSection
      id="kh-settings-security"
      title="Security & session"
      description="When the vault locks itself, how long a copied password lives, and who can open the vault without your master password. All of this is stored on this computer — it does not travel with the vault file."
    >
      <p className="kh-settings-section__scope">
        <ScopeBadge scope="machine" /> Everything in this section
      </p>

      <fieldset className="kh-fieldset">
        <legend className="kh-fieldset__legend">Automatic locking</legend>

        <SettingSelect
          settingId="autoLock.idleMinutes"
          choices={IDLE_MINUTE_CHOICES}
          value={machine.autoLock.idleMinutes}
          tradeOffActive={weakened.has('autoLock.idleMinutes')}
          onChange={(idleMinutes) => {
            setAutoLock(
              { idleMinutes },
              idleMinutes === null
                ? 'Idle locking turned off.'
                : `Locking after ${idleMinutes} minutes idle.`
            );
          }}
        />

        <SettingSwitch
          settingId="autoLock.lockOnSleep"
          checked={machine.autoLock.lockOnSleep}
          tradeOffActive={weakened.has('autoLock.lockOnSleep')}
          onChange={(lockOnSleep) => {
            setAutoLock(
              { lockOnSleep },
              lockOnSleep ? 'Locking when the computer sleeps.' : 'No longer locking on sleep.'
            );
          }}
        />

        <SettingSwitch
          settingId="autoLock.lockOnScreenLock"
          checked={machine.autoLock.lockOnScreenLock}
          tradeOffActive={weakened.has('autoLock.lockOnScreenLock')}
          onChange={(lockOnScreenLock) => {
            setAutoLock(
              { lockOnScreenLock },
              lockOnScreenLock
                ? 'Locking when the screen locks.'
                : 'No longer locking when the screen locks.'
            );
          }}
        />

        <SettingSwitch
          settingId="autoLock.lockOnMinimise"
          checked={machine.autoLock.lockOnMinimise}
          onChange={(lockOnMinimise) => {
            setAutoLock(
              { lockOnMinimise },
              lockOnMinimise ? 'Locking on minimise.' : 'No longer locking on minimise.'
            );
          }}
        />

        <SettingSwitch
          settingId="autoLock.lockOnBlur"
          checked={machine.autoLock.lockOnBlur}
          onChange={(lockOnBlur) => {
            setAutoLock(
              { lockOnBlur },
              lockOnBlur
                ? 'Locking when the window loses focus.'
                : 'No longer locking on focus loss.'
            );
          }}
        />
      </fieldset>

      <fieldset className="kh-fieldset">
        <legend className="kh-fieldset__legend">Clipboard</legend>

        <SettingSelect
          settingId="clipboardClearMs"
          choices={CLIPBOARD_CHOICES}
          value={machine.clipboardClearMs}
          tradeOffActive={weakened.has('clipboardClearMs')}
          onChange={(clipboardClearMs) => {
            controller.updateMachine(
              { clipboardClearMs },
              clipboardClearMs === null
                ? 'The clipboard will not be cleared automatically.'
                : `Clearing the clipboard after ${Math.round(clipboardClearMs / 1000)} seconds.`
            );
          }}
        />
      </fieldset>

      <fieldset className="kh-fieldset">
        <legend className="kh-fieldset__legend">Revealing secrets</legend>

        <SettingSelect
          settingId="secretReveal.maxRevealsPerWindow"
          choices={REVEAL_LIMIT_CHOICES}
          value={machine.secretReveal.maxRevealsPerWindow}
          tradeOffActive={weakened.has('secretReveal.maxRevealsPerWindow')}
          onChange={(maxRevealsPerWindow) => {
            controller.updateMachine(
              {
                secretReveal: { ...machine.secretReveal, maxRevealsPerWindow },
              },
              `Reveal limit set to ${maxRevealsPerWindow} a minute.`
            );
          }}
        />

        <SettingSelect
          settingId="secretReveal.grantTtlMs"
          choices={GRANT_TTL_CHOICES}
          value={machine.secretReveal.grantTtlMs}
          tradeOffActive={weakened.has('secretReveal.grantTtlMs')}
          onChange={(grantTtlMs) => {
            controller.updateMachine(
              { secretReveal: { ...machine.secretReveal, grantTtlMs } },
              `Revealed secrets now expire after ${Math.round(grantTtlMs / 1000)} seconds.`
            );
          }}
        />
      </fieldset>

      <fieldset className="kh-fieldset">
        <legend className="kh-fieldset__legend">Quick unlock</legend>

        <div className="kh-setting">
          <div className="kh-setting__head">
            <span className="kh-setting__label" id="kh-quick-unlock-label">
              {SETTING_COPY.quickUnlock.label}
            </span>
            <ScopeBadge scope="machine" />
          </div>

          {/* Verbatim from the main process. Never rephrased here — see the file header. */}
          <p className="kh-setting__help" id="kh-quick-unlock-description">
            {quickUnlock.description}
          </p>

          <p className="kh-setting__help">{SETTING_COPY.quickUnlock.help}</p>

          <div className="kh-setting__control">
            <span className="kh-setting__state">
              {quickUnlock.enrolled ? 'On for this vault' : 'Off'}
            </span>
            <Button
              variant={quickUnlock.enrolled ? 'secondary' : 'primary'}
              size="sm"
              disabled={!quickUnlock.available || !hasVault || controller.busy}
              aria-describedby="kh-quick-unlock-description"
              onClick={() => {
                void controller.perform(
                  quickUnlock.enrolled
                    ? 'Quick unlock turned off for this vault.'
                    : 'Quick unlock turned on for this vault.',
                  (gateway) => gateway.setQuickUnlock(!quickUnlock.enrolled)
                );
              }}
            >
              {quickUnlock.enrolled ? 'Turn off for this vault' : 'Turn on for this vault'}
            </Button>
          </div>

          {!hasVault && (
            <p className="kh-setting__help">
              Open a vault to change this — quick unlock is enrolled per vault, not per app.
            </p>
          )}
        </div>
      </fieldset>

      <fieldset className="kh-fieldset kh-fieldset--caution">
        <legend className="kh-fieldset__legend">Erase after repeated failures</legend>

        <SettingSelect
          settingId="wipeAfterFailedAttempts"
          choices={WIPE_CHOICES}
          value={machine.wipeAfterFailedAttempts}
          tradeOffActive={weakened.has('wipeAfterFailedAttempts')}
          onChange={(attempts) => {
            // Turning it OFF is safe and applies straight away. Turning it on is the one
            // change on this screen that can lose the vault, so it asks first.
            if (attempts === null) {
              controller.updateMachine(
                { wipeAfterFailedAttempts: null },
                'The vault will not be erased after failed unlocks.'
              );
              return;
            }
            setPendingWipe(attempts);
          }}
        />
      </fieldset>

      <ConfirmDialog
        open={pendingWipe !== null}
        title="Erase this vault after failed unlocks?"
        message={
          pendingWipe === null
            ? ''
            : `Keyhold will permanently delete the vault file, and its rolling backups, after ${pendingWipe} consecutive failed unlock attempts.`
        }
        consequence="There is no recovery. A forgotten master password, or someone else at your keyboard, is enough to trigger this."
        confirmLabel={pendingWipe === null ? 'Turn on' : `Erase after ${pendingWipe} failures`}
        destructive
        busy={controller.busy}
        onCancel={() => {
          setPendingWipe(null);
        }}
        onConfirm={() => {
          const attempts = pendingWipe;
          setPendingWipe(null);
          if (attempts !== null) {
            controller.updateMachine(
              { wipeAfterFailedAttempts: attempts },
              `The vault will be erased after ${attempts} failed unlocks.`
            );
          }
        }}
      />
    </SettingsSection>
  );
}
