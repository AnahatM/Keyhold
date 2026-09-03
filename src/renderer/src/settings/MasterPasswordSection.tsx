// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import type { PasswordStrength } from '@shared/model/strength.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { StrengthReadout } from '../components/StrengthReadout.js';
import { Modal } from '../chrome/index.js';
import { useSession } from '../vault/session-store.js';
import { SettingsSection, ScopeBadge } from './SettingControls.js';
import type { SettingsController } from './use-settings.js';

/**
 * Changing the master password.
 *
 * ## Why this is cheap, and why saying so matters
 *
 * The vault body is not re-encrypted. Keyhold wraps a random data key under a key derived
 * from the master password, so changing the password re-wraps 32 bytes and rewrites a
 * header — it takes as long as one Argon2 derivation and no longer, whether the vault holds
 * ten records or ten thousand. The copy says this out loud because the alternative design
 * is common enough that users brace for a long, dangerous-looking operation, and bracing
 * for one is how a person talks themselves out of rotating a password they should rotate.
 *
 * ## The strength bar is the same bar
 *
 * A new master password is held to the same standard as the one that created the vault, and
 * measured by the same estimator — `src/main/session/strength.ts`, in the main process, so
 * the password never crosses the bridge. Nothing here re-derives a score, and in particular
 * nothing here measures a password's length: `onboarding-state.test.ts` has a guard that
 * greps the renderer for exactly that, because a hand-rolled meter is not a simpler version
 * of zxcvbn, it is a different and wrong answer.
 *
 * The main process re-checks the bar on `kh:settings:change-master-password` regardless.
 * What this screen shows is a courtesy; the refusal is the rule.
 *
 * ## Nothing lingers
 *
 * All three fields are cleared on every exit path — submit, cancel, Escape, and the
 * unmount that follows a successful change. No password reaches a log, an error message or
 * the live-region announcement.
 */

export interface MasterPasswordSectionProps {
  readonly controller: SettingsController;
  readonly hasVault: boolean;
  readonly quickUnlockEnrolled: boolean;
}

export function MasterPasswordSection({
  controller,
  hasVault,
  quickUnlockEnrolled,
}: MasterPasswordSectionProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <SettingsSection
      id="kh-settings-master-password"
      title="Master password"
      description="The one password that opens this vault. It is never stored, never sent anywhere, and cannot be recovered."
    >
      <p className="kh-settings-section__scope">
        <ScopeBadge scope="vault" /> Everything in this section
      </p>

      <div className="kh-setting">
        <div className="kh-setting__head">
          <span className="kh-setting__label">Change the master password</span>
          <ScopeBadge scope="vault" />
        </div>
        <p className="kh-setting__control">
          <Button
            variant="secondary"
            disabled={!hasVault || controller.busy}
            onClick={() => {
              setOpen(true);
            }}
          >
            Change master password…
          </Button>
        </p>
        <p className="kh-setting__help">
          {hasVault
            ? 'Fast, whatever the vault holds. Keyhold re-wraps the key your records are encrypted with rather than re-encrypting the records themselves, so this takes about as long as one unlock.'
            : 'Open a vault to change its master password.'}
        </p>
      </div>

      {open && (
        <ChangeMasterPasswordDialog
          controller={controller}
          quickUnlockEnrolled={quickUnlockEnrolled}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </SettingsSection>
  );
}

function ChangeMasterPasswordDialog({
  controller,
  quickUnlockEnrolled,
  onClose,
}: {
  readonly controller: SettingsController;
  readonly quickUnlockEnrolled: boolean;
  readonly onClose: () => void;
}): React.JSX.Element {
  const estimateStrength = useSession((state) => state.estimateStrength);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [estimate, setEstimate] = useState<{
    readonly of: string;
    readonly strength: PasswordStrength;
  } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (next === '') return;

    let cancelled = false;
    void estimateStrength(next).then((result) => {
      if (!cancelled && result !== null) setEstimate({ of: next, strength: result });
    });
    return () => {
      cancelled = true;
    };
  }, [next, estimateStrength]);

  // Derived at render rather than cleared in the effect, which matters twice over. Estimates
  // race — an earlier keystroke's result can land after a later one — and carrying the
  // password each result was *for* makes a stale score unrenderable rather than merely
  // unlikely. It also means the empty field needs no state change, so nothing here calls
  // setState from an effect body.
  const strength = estimate !== null && estimate.of === next ? estimate.strength : null;

  const mismatch = confirm !== '' && confirm !== next;
  const strongEnough = strength?.meetsMasterMinimum ?? false;
  const canSubmit =
    current !== '' && next !== '' && next === confirm && strongEnough && acknowledged;

  const clear = (): void => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setEstimate(null);
    setAcknowledged(false);
  };

  const close = (): void => {
    clear();
    onClose();
  };

  const submit = (): void => {
    // Copied out and the fields emptied before the call, not after it: an await that fails
    // must not leave two master passwords sitting in component state while an error banner
    // is read.
    const currentAttempt = current;
    const nextAttempt = next;
    clear();

    void controller
      .perform('Master password changed.', async (gateway) => {
        await gateway.changeMasterPassword(currentAttempt, nextAttempt);
        // `null` keeps the snapshot as it is. Nothing this screen renders changed — the KDF
        // salt did, and that is not on screen — so re-reading would only be ceremony.
        return null;
      })
      .then((ok) => {
        if (ok) onClose();
      });
  };

  return (
    <Modal
      open
      title="Change the master password"
      description="Your records are not re-encrypted. Keyhold re-wraps the key that protects them, so this is quick however much the vault holds."
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
            disabled={!canSubmit}
            onClick={submit}
          >
            Change master password
          </Button>
        </>
      }
    >
      <ul className="kh-consequences">
        <li>
          <strong>There is still no way to recover it.</strong> No account, no server, no reset
          link. If you forget the new password, the vault and everything in it is gone.
        </li>
        {quickUnlockEnrolled && (
          <li>
            <strong>Quick unlock will be turned off.</strong> It stores a copy of this vault&rsquo;s
            key that opens the vault without any password at all, so a password change that left it
            in place would not be much of a change. You can turn it on again afterwards.
          </li>
        )}
        <li>Nothing about your credentials changes, and no record is rewritten.</li>
      </ul>

      <Input
        label="Current master password"
        type="password"
        autoComplete="current-password"
        value={current}
        hint="Needed to prove it is you — the vault being open is not proof that the person at the keyboard knows the password."
        onChange={(event) => {
          setCurrent(event.target.value);
        }}
      />

      <Input
        label="New master password"
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={(event) => {
          setNext(event.target.value);
        }}
      />

      {strength !== null && <StrengthReadout strength={strength} />}

      <Input
        label="Confirm new master password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(event) => {
          setConfirm(event.target.value);
        }}
        {...(mismatch ? { error: 'The two passwords do not match.' } : {})}
      />

      <label className="kh-ack">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => {
            setAcknowledged(event.target.checked);
          }}
        />
        <span>
          <strong>I understand there is no way to recover this password.</strong>
          <small>
            Write it down and keep it somewhere safe before you continue. Keyhold cannot help you
            back into a vault whose master password is lost.
          </small>
        </span>
      </label>
    </Modal>
  );
}
