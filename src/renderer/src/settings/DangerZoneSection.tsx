// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import type { QuickUnlockSummary } from '@shared/model/settings-plan.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { ConfirmDialog, Modal } from '../chrome/index.js';
import { SettingsSection } from './SettingControls.js';
import type { SettingsController } from './use-settings.js';

/**
 * The three operations that cannot be undone by clicking the same control again.
 *
 * Each one is behind an explicit confirmation that names **what it costs**, not merely that
 * it is irreversible. "Are you sure?" is a speed bump; "this deletes 412 stored versions,
 * and every previous password in them" is a decision.
 *
 * The section is marked as dangerous in words as well as in colour — `SettingsSection`
 * renders the phrase "Danger zone" into the heading — because a red border is invisible to
 * a colour-blind reader and to anyone in the high-contrast theme.
 *
 * **The master-password flow never echoes, logs or keeps the password.** The three fields
 * live in component state while the dialog is open, are cleared the instant the call is
 * made, and are cleared again on cancel. Neither value is put into an announcement, an
 * error message or a toast: an error message is exactly the place a secret ends up by
 * accident, which is why hard rule 1 names it.
 */

export interface DangerZoneSectionProps {
  readonly controller: SettingsController;
  readonly quickUnlock: QuickUnlockSummary;
  readonly historyVersionCount: number;
  readonly hasVault: boolean;
}

type OpenDialog = 'password' | 'history' | 'quick-unlock' | null;

export function DangerZoneSection({
  controller,
  quickUnlock,
  historyVersionCount,
  hasVault,
}: DangerZoneSectionProps): React.JSX.Element {
  const [open, setOpen] = useState<OpenDialog>(null);

  const close = (): void => {
    setOpen(null);
  };

  return (
    <SettingsSection
      id="kh-settings-danger"
      danger
      title="Advanced"
      description="Operations that change or destroy something permanently. Each asks first, and says what it costs."
    >
      <div className="kh-danger-row">
        <div className="kh-danger-row__body">
          <h4 className="kh-danger-row__title">Change the master password</h4>
          <p className="kh-danger-row__help">
            Instant, whatever the size of the vault: your password protects a key, and only that key
            is re-wrapped. No record is rewritten, and nothing else changes. There is still no
            recovery if you forget the new one.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={!hasVault || controller.busy}
          onClick={() => {
            setOpen('password');
          }}
        >
          Change master password
        </Button>
      </div>

      <div className="kh-danger-row">
        <div className="kh-danger-row__body">
          <h4 className="kh-danger-row__title">Clear all history</h4>
          <p className="kh-danger-row__help">
            Removes every stored version from every record in this vault —{' '}
            {historyVersionCount === 0
              ? 'there are none stored right now'
              : `${historyVersionCount} in total`}
            . Your current credentials are untouched; what goes is every earlier value, and the
            record of which device and network each change came from.
          </p>
        </div>
        <Button
          variant="danger"
          disabled={!hasVault || controller.busy || historyVersionCount === 0}
          onClick={() => {
            setOpen('history');
          }}
        >
          Clear all history
        </Button>
      </div>

      <div className="kh-danger-row">
        <div className="kh-danger-row__body">
          <h4 className="kh-danger-row__title">Forget quick unlock</h4>
          <p className="kh-danger-row__help">
            Deletes the copy of this vault&rsquo;s key held in your operating system&rsquo;s key
            store. That copy is the only thing quick unlock uses, so removing it is the whole
            revocation — nothing about the vault itself changes, and your master password still
            works.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={!hasVault || !quickUnlock.enrolled || controller.busy}
          onClick={() => {
            setOpen('quick-unlock');
          }}
        >
          {quickUnlock.enrolled ? 'Forget quick unlock' : 'Not enrolled'}
        </Button>
      </div>

      <ChangePasswordDialog open={open === 'password'} controller={controller} onClose={close} />

      <ConfirmDialog
        open={open === 'history'}
        title="Clear the history of every record?"
        message={`This permanently removes ${historyVersionCount} stored version${historyVersionCount === 1 ? '' : 's'} from this vault.`}
        consequence="Every previous password, and every record of which device and network a change came from, is gone. This cannot be undone, and no backup is taken."
        confirmLabel="Clear all history"
        destructive
        busy={controller.busy}
        onCancel={close}
        onConfirm={() => {
          void controller
            .perform('History cleared for every record.', async (gateway) => {
              await gateway.clearAllHistory();
              return null;
            })
            .then((ok) => {
              if (ok) close();
            });
        }}
      />

      <ConfirmDialog
        open={open === 'quick-unlock'}
        title="Forget quick unlock for this vault?"
        message="Keyhold will delete the copy of this vault's key stored by your operating system."
        consequence="You will need your master password the next time you open this vault. Nothing else is lost, and you can enrol again at any time."
        confirmLabel="Forget it"
        busy={controller.busy}
        onCancel={close}
        onConfirm={() => {
          void controller
            .perform('Quick unlock forgotten for this vault.', (gateway) =>
              gateway.setQuickUnlock(false)
            )
            .then((ok) => {
              if (ok) close();
            });
        }}
      />
    </SettingsSection>
  );
}

/**
 * The master-password change.
 *
 * Confirmation of the new password is required rather than optional: a typo in the only
 * copy of an unrecoverable secret locks the user out of everything they own, and "type it
 * twice" is the cheapest possible defence against it.
 */
function ChangePasswordDialog({
  open,
  controller,
  onClose,
}: {
  readonly open: boolean;
  readonly controller: SettingsController;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');

  const mismatch = repeat !== '' && next !== repeat;
  const ready = current !== '' && next !== '' && next === repeat;

  /** Wipes all three fields. Called on every exit path, success or not. */
  const forget = (): void => {
    setCurrent('');
    setNext('');
    setRepeat('');
  };

  const close = (): void => {
    forget();
    onClose();
  };

  const submit = (): void => {
    const currentSecret = current;
    const nextSecret = next;
    forget();
    void controller
      .perform(
        // Deliberately says nothing about the password itself — not its length, not a
        // fragment. An announcement is read aloud in a room.
        'Master password changed.',
        async (gateway) => {
          await gateway.changeMasterPassword(currentSecret, nextSecret);
          return null;
        }
      )
      .then((ok) => {
        if (ok) onClose();
      });
  };

  return (
    <Modal
      open={open}
      title="Change the master password"
      description="Your credentials are re-protected under the new password immediately. Nothing is re-encrypted, so this is instant however large the vault is."
      onClose={close}
      size="sm"
      closeOnBackdropClick={false}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={controller.busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={controller.busy} disabled={!ready} onClick={submit}>
            Change it
          </Button>
        </>
      }
    >
      <p className="kh-consequence-note">
        <span aria-hidden="true">⚠</span> There is no recovery. If you forget the new password, the
        vault cannot be opened by anyone, including us.
      </p>

      <Input
        label="Current master password"
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={(event) => {
          setCurrent(event.target.value);
        }}
      />
      <Input
        label="New master password"
        type="password"
        autoComplete="new-password"
        value={next}
        hint="Keyhold applies the same minimum it does when a vault is created — a real strength check, not a count of character types."
        onChange={(event) => {
          setNext(event.target.value);
        }}
      />
      <Input
        label="New master password again"
        type="password"
        autoComplete="new-password"
        value={repeat}
        {...(mismatch ? { error: 'The two new passwords do not match.' } : {})}
        onChange={(event) => {
          setRepeat(event.target.value);
        }}
      />
    </Modal>
  );
}
