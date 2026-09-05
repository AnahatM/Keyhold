// SPDX-License-Identifier: GPL-3.0-or-later
import type { MachineSettings } from '@shared/model/settings-plan.js';
import { SettingSwitch, SettingsSection } from './SettingControls.js';
import type { SettingsController } from './use-settings.js';

/**
 * The system tray, and the two window gestures that can hide into it.
 *
 * **This section exists because the group shipped without one.** `showTrayIcon` defaulted
 * to `true`, nothing loaded an icon, and nothing rendered a control — so every launch asked
 * for a tray, took the "no tray icon available" branch, and gave the user nothing. The icon
 * is wired now; this is the other half, and hard rule 7 is what makes it the other half
 * rather than a nice-to-have.
 *
 * Machine-scoped throughout: a tray belongs to the desktop you are sitting at, not to the
 * vault file. The section carries no `ScopeBadge` rows for that reason — every control in it
 * has the same scope, and the heading says so once instead of thirteen times.
 *
 * ## The one interaction worth knowing
 *
 * Turning the icon **off** turns the two hide-to-tray gestures off with it, and the switches
 * disable rather than merely stopping working. Hiding into a tray that does not exist leaves
 * the window hidden — not minimised, with no icon to bring it back — which is a lockout
 * rather than a preference. `coerceShellSettings` refuses the combination on the way in, so
 * the disabling here is the UI agreeing with the model rather than enforcing anything.
 */
export interface TraySectionProps {
  readonly controller: SettingsController;
  readonly machine: MachineSettings;
}

export function TraySection({ controller, machine }: TraySectionProps): React.JSX.Element {
  const tray = machine.tray;

  /**
   * Sends the whole group, never one field.
   *
   * The IPC validator requires every field of `tray` for a reason worth repeating here: a
   * partial object would leave the omitted fields to whatever the spread happened to put
   * there, which for a security-relevant flag like `lockOnHideToTray` is not an acceptable
   * way to arrive at a value.
   */
  const update = (patch: Partial<MachineSettings['tray']>, announce: string): void => {
    controller.updateMachine({ tray: { ...tray, ...patch } }, announce);
  };

  return (
    <SettingsSection
      id="kh-settings-tray"
      title="System tray"
      description="Whether Keyhold appears in the notification area, and what the window does when you close or minimise it. Stored on this computer — a vault carried elsewhere does not bring these with it."
    >
      <fieldset className="kh-fieldset">
        <legend className="kh-fieldset__legend">The icon</legend>

        <SettingSwitch
          settingId="tray.showTrayIcon"
          checked={tray.showTrayIcon}
          onChange={(showTrayIcon) => {
            update(
              // Turning the icon off takes the two gestures with it, rather than leaving a
              // stored `true` that would come back the moment the icon returned.
              showTrayIcon
                ? { showTrayIcon }
                : { showTrayIcon, closeToTray: false, minimiseToTray: false },
              showTrayIcon ? 'Keyhold now shows a tray icon.' : 'The tray icon is hidden.'
            );
          }}
        />
      </fieldset>

      <fieldset className="kh-fieldset">
        <legend className="kh-fieldset__legend">Closing and minimising</legend>

        <SettingSwitch
          settingId="tray.closeToTray"
          checked={tray.closeToTray}
          disabled={!tray.showTrayIcon}
          tradeOffActive={tray.closeToTray}
          onChange={(closeToTray) => {
            update(
              { closeToTray },
              closeToTray
                ? 'Closing the window now keeps Keyhold running in the tray.'
                : 'Closing the window now quits Keyhold.'
            );
          }}
        />

        <SettingSwitch
          settingId="tray.minimiseToTray"
          checked={tray.minimiseToTray}
          disabled={!tray.showTrayIcon}
          onChange={(minimiseToTray) => {
            update(
              { minimiseToTray },
              minimiseToTray
                ? 'Minimising now hides Keyhold to the tray.'
                : 'Minimising now sends Keyhold to the taskbar.'
            );
          }}
        />

        {/*
          On by default, and the only switch in this section whose trade-off is active when
          it is OFF — like `blockScreenCapture` on the security screen, it is a protection
          being removed rather than a capability being granted.
        */}
        <SettingSwitch
          settingId="tray.lockOnHideToTray"
          checked={tray.lockOnHideToTray}
          tradeOffActive={!tray.lockOnHideToTray}
          onChange={(lockOnHideToTray) => {
            update(
              { lockOnHideToTray },
              lockOnHideToTray
                ? 'Hiding to the tray now locks the vault.'
                : 'Hiding to the tray no longer locks the vault.'
            );
          }}
        />
      </fieldset>
    </SettingsSection>
  );
}
