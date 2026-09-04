// SPDX-License-Identifier: GPL-3.0-or-later
import { useId, useState } from 'react';
import {
  DEFAULT_KDF_COST,
  KDF_PRESETS,
  KDF_PRESET_IDS,
  KDF_UI_FLOOR,
  clampKdfCost,
  isKdfCostBelowFloor,
  kdfPresetFor,
  type ConfigurableVaultSettings,
  type KdfCost,
  type KdfPresetId,
  type MachineSettings,
  type MirrorStatusView,
} from '@shared/model/settings-plan.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { Modal } from '../chrome/index.js';
import { SettingSelect, SettingsSection, ScopeBadge } from './SettingControls.js';
import {
  KDF_PRESET_COPY,
  SETTING_COPY,
  TRASH_RETENTION_CHOICES,
  formatKdfCost,
  formatMemory,
  vaultWeakenings,
} from './settings-copy.js';
import type { SettingsController } from './use-settings.js';
import './mirror.css';
import { Icon } from '../components/Icon.js';

/**
 * The vault file itself: where it is, how long the trash keeps things, and how expensive it
 * is to turn the master password into a key.
 *
 * ## The KDF control, and why it has a floor of its own
 *
 * The format layer accepts a vault down to 19 MiB of Argon2 memory, because it has to be
 * able to *open* a file written by an older or third-party tool. This screen will not go
 * below the shipped default of {@link KDF_UI_FLOOR}, because what the app may *create* is a
 * different question from what it may read. `calibrateKdf` already refuses to calibrate
 * below the default — on a fast machine the search can hit its time target early, and
 * accepting that would mean a powerful computer produced a weaker vault than a slow one. A
 * settings screen able to undo that guard would not be a setting; it would be a hole.
 *
 * So the control offers presets, every preset is at or above the floor, and every value
 * still passes through `clampKdfCost` before it is sent. Belt and braces on purpose: the
 * clamp is the guarantee, and the preset list is the reason nobody has to think about it.
 *
 * ## The password never lingers
 *
 * Re-keying re-derives the key-encryption key, so it needs the master password. It is held
 * in component state for exactly as long as the dialog is open, cleared the instant the
 * call is made — success or failure — and never written to a log, an error message or the
 * announcement. Nothing on this screen ever displays it.
 */

export interface VaultSectionProps {
  readonly controller: SettingsController;
  readonly vault: ConfigurableVaultSettings;
  /** One control here is machine-scoped: where the off-machine copy goes. */
  readonly machine: MachineSettings;
  readonly mirror: MirrorStatusView | null;
  readonly vaultPath: string | null;
  readonly kdf: KdfCost | null;
  readonly quickUnlockEnrolled: boolean;
}

export function VaultSection({
  controller,
  vault,
  machine,
  mirror,
  vaultPath,
  kdf,
  quickUnlockEnrolled,
}: VaultSectionProps): React.JSX.Element {
  const weakened = vaultWeakenings(vault, kdf);
  const base = useId();
  const [rekeyTo, setRekeyTo] = useState<KdfPresetId | null>(null);

  const currentPreset = kdf === null ? null : kdfPresetFor(kdf);

  return (
    <SettingsSection
      id="kh-settings-vault"
      title="Vault"
      description="The file your credentials live in, and the cost of opening it. Everything here is a property of the vault, so it follows the file wherever it goes."
    >
      <p className="kh-settings-section__scope">
        <ScopeBadge scope="vault" /> Everything in this section
      </p>

      <div className="kh-setting">
        <div className="kh-setting__head">
          <span className="kh-setting__label">Where this vault is</span>
          <ScopeBadge scope="vault" />
        </div>
        <p className="kh-setting__control">
          <code className="kh-path">{vaultPath ?? 'No vault is open.'}</code>
        </p>
        <p className="kh-setting__help">
          One file. Back it up the way you back up anything else — a copy is a complete,
          still-encrypted vault, and it can only be opened with your master password.
        </p>
      </div>

      <fieldset className="kh-fieldset">
        <legend className="kh-fieldset__legend">
          Copy to another folder
          <ScopeBadge scope="machine" />
        </legend>

        {/*
          Machine-scoped, and the badge says so, because the path names a drive or a share on
          *this* computer. A vault carried elsewhere must not bring a destination with it.

          There is no warning here and no confirmation, deliberately: a `.keep` is a sealed
          container, so copying one to a USB stick reveals nothing that leaving it on the disk
          did not. None of the plaintext exports could be scheduled this way, which is the
          difference worth understanding rather than a caveat worth printing.
        */}
        <p className="kh-setting__help">
          After every save, Keyhold writes a dated copy of this vault to a folder you choose — an
          external drive, a network share, a synced folder. The rolling backups beside the vault
          protect against a bad write; this protects against losing the whole folder. The copy is
          still encrypted and still needs your master password.
        </p>

        <div className="kh-mirror">
          <span className="kh-mirror__path">{machine.mirrorDirectory ?? 'Not set'}</span>
          <Button
            variant="secondary"
            size="sm"
            icon="folder"
            disabled={controller.busy}
            onClick={() => {
              void controller.chooseMirrorDirectory();
            }}
          >
            {machine.mirrorDirectory === null ? 'Choose a folder…' : 'Change folder'}
          </Button>
          {machine.mirrorDirectory !== null && (
            <Button
              variant="ghost"
              size="sm"
              icon="close"
              disabled={controller.busy}
              onClick={() => {
                controller.updateMachine(
                  { mirrorDirectory: null },
                  'Keyhold will no longer copy this vault anywhere else.'
                );
              }}
            >
              Turn off
            </Button>
          )}
        </div>

        {mirror !== null && (
          <p
            className={mirror.status === 'failed' ? 'kh-mirror__failed' : 'kh-mirror__ok'}
            role="status"
          >
            {mirror.status === 'failed'
              ? `The last copy did not work. ${mirror.problem ?? ''}`
              : `Last copy: ${mirror.fileName ?? ''}`}
          </p>
        )}
      </fieldset>

      <fieldset className="kh-fieldset">
        <legend className="kh-fieldset__legend">Trash</legend>

        <SettingSelect
          settingId="trashRetentionDays"
          choices={TRASH_RETENTION_CHOICES}
          value={vault.trashRetentionDays}
          onChange={(trashRetentionDays) => {
            controller.updateVault(
              { trashRetentionDays },
              trashRetentionDays === null
                ? 'Trashed records will be kept until you empty the trash.'
                : `Trashed records will be kept for ${trashRetentionDays} days.`
            );
          }}
        />
      </fieldset>

      <fieldset className="kh-fieldset">
        <legend className="kh-fieldset__legend">
          {SETTING_COPY.kdfCost.label}
          <ScopeBadge scope="vault" />
        </legend>

        <p id={`${base}-kdf-help`} className="kh-setting__help">
          {SETTING_COPY.kdfCost.help}
        </p>

        <p
          className={`kh-tradeoff${weakened.has('kdfCost') ? ' kh-tradeoff--active' : ''}`}
          id={`${base}-kdf-tradeoff`}
        >
          <span className="kh-tradeoff__symbol" aria-hidden="true">
            <Icon name={weakened.has('kdfCost') ? 'warning' : 'info'} size="sm" />
          </span>
          <span className="kh-tradeoff__label">
            {weakened.has('kdfCost') ? 'In effect:' : 'Trade-off:'}
          </span>{' '}
          {SETTING_COPY.kdfCost.tradeOff}
        </p>

        <p className="kh-setting__state">
          Currently: {kdf === null ? 'unknown — no vault is open' : formatKdfCost(kdf)}
        </p>

        <ul className="kh-kdf-presets">
          {KDF_PRESET_IDS.map((preset) => {
            const cost = KDF_PRESETS[preset];
            const copy = KDF_PRESET_COPY[preset];
            const isCurrent = currentPreset === preset;

            return (
              <li key={preset} className={`kh-kdf${isCurrent ? ' kh-kdf--current' : ''}`}>
                <div className="kh-kdf__head">
                  <span className="kh-kdf__name">{copy.name}</span>
                  <span className="kh-kdf__cost">{formatKdfCost(cost)}</span>
                  {isCurrent && <span className="kh-kdf__current-word">In use</span>}
                </div>
                <p className="kh-kdf__note">{copy.note}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isCurrent || vaultPath === null || controller.busy}
                  onClick={() => {
                    setRekeyTo(preset);
                  }}
                >
                  {isCurrent ? 'In use' : `Change to ${copy.name}`}
                </Button>
              </li>
            );
          })}
        </ul>

        <p className="kh-setting__help">
          Keyhold will not go below {formatMemory(KDF_UI_FLOOR.memoryKib)} and{' '}
          {KDF_UI_FLOOR.iterations} passes — the settings it ships with. A weaker vault is something
          the app can open, not something it will create.
        </p>
      </fieldset>

      <RekeyDialog
        preset={rekeyTo}
        controller={controller}
        quickUnlockEnrolled={quickUnlockEnrolled}
        onClose={() => {
          setRekeyTo(null);
        }}
      />
    </SettingsSection>
  );
}

/**
 * Confirming a re-key, with the master password.
 *
 * A dialog rather than an inline field because it has three things to say before anything
 * happens — that the key is re-derived, that quick unlock is invalidated, and how much
 * slower every future unlock becomes — and none of them fit beside a button.
 */
function RekeyDialog({
  preset,
  controller,
  quickUnlockEnrolled,
  onClose,
}: {
  readonly preset: KdfPresetId | null;
  readonly controller: SettingsController;
  readonly quickUnlockEnrolled: boolean;
  readonly onClose: () => void;
}): React.JSX.Element | null {
  const [secret, setSecret] = useState('');

  if (preset === null) return null;

  const requested = KDF_PRESETS[preset];
  // Belt and braces: the presets are all at or above the floor, and the value is clamped
  // anyway, so no path from this screen can send a weaker cost than the shipped default.
  const cost = clampKdfCost(requested);
  const wouldHaveBeenWeak = isKdfCostBelowFloor(requested);

  const close = (): void => {
    // Cleared before anything else, on every exit path.
    setSecret('');
    onClose();
  };

  const submit = (): void => {
    const attempt = secret;
    setSecret('');
    void controller
      .perform(`Vault re-keyed at ${formatKdfCost(cost)}.`, (gateway) =>
        gateway.rekey(attempt, cost)
      )
      .then((ok) => {
        if (ok) onClose();
      });
  };

  return (
    <Modal
      open
      title={`Change the unlock cost to ${KDF_PRESET_COPY[preset].name}?`}
      description="Your master password does not change. Keyhold re-derives the key it protects, at the new cost."
      onClose={close}
      size="sm"
      closeOnBackdropClick={false}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={controller.busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={controller.busy}
            disabled={secret === ''}
            onClick={submit}
          >
            Re-key at {formatKdfCost(cost)}
          </Button>
        </>
      }
    >
      <ul className="kh-consequences">
        <li>Every future unlock of this vault will take {KDF_PRESET_COPY[preset].note}</li>
        {quickUnlockEnrolled && (
          <li>
            <strong>Quick unlock will be turned off.</strong> Its stored key is tied to the current
            one, so re-keying invalidates it. You can turn it on again afterwards.
          </li>
        )}
        <li>Nothing about your credentials changes, and no record is rewritten.</li>
        {wouldHaveBeenWeak && (
          <li>
            This preset was raised to Keyhold&rsquo;s minimum of{' '}
            {formatMemory(DEFAULT_KDF_COST.memoryKib)}.
          </li>
        )}
      </ul>

      <Input
        label="Master password"
        type="password"
        autoComplete="current-password"
        value={secret}
        hint="Needed to re-derive the key. It is used for this one call and never stored."
        onChange={(event) => {
          setSecret(event.target.value);
        }}
      />
    </Modal>
  );
}
