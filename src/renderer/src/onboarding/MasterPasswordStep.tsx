// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import type { PasswordStrength } from '@shared/model/strength.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import {
  NO_RECOVERY_ACKNOWLEDGEMENT,
  NO_RECOVERY_EXPLANATION,
  NO_RECOVERY_HEADING,
} from './onboarding-copy.js';
import { canCreateVault, masterPasswordBlocker } from './onboarding-state.js';
import { StrengthReadout } from './StrengthReadout.js';
// `.kh-ack`, `.kh-screen__error` and `.kh-path` are defined there. The acknowledgement is
// deliberately the same control the create screen uses — a second styling of the single
// most important checkbox in the app is how the two quietly stop matching.
import '../vault/vault-screens.css';
import './onboarding.css';

/**
 * The one step that matters.
 *
 * Three things have to be true when someone leaves this screen, and only one of them is
 * about software:
 *
 * 1. The password is genuinely strong enough — judged by the estimator in the main process,
 *    never by a second definition invented here.
 * 2. They have been told, unmissably and exactly once, that there is no reset.
 * 3. They have said, deliberately, that they understood.
 *
 * **The friction here is correct.** It is the only place in Keyhold where a checkbox stands
 * between a user and what they want, and it stands there because the alternative — a
 * paragraph of warning text above a Create button — is a paragraph people scroll past and
 * then, six months later, lose everything to. A tick is not proof that someone read it. It
 * is proof that they were given a moment where reading it was the obvious thing to do,
 * which fine print never provides.
 *
 * It is not, however, a dark pattern in the other direction: there is no guilt copy, no
 * "are you sure you want to be insecure", and Skip is on screen the whole time. Someone who
 * wants out gets out, and the ordinary create screen carries the same acknowledgement.
 */

export interface MasterPasswordStepProps {
  readonly vaultPath: string | null;
  readonly acknowledged: boolean;
  readonly onAcknowledgedChange: (value: boolean) => void;
  /** The main process's estimator. `null` means the estimate failed — never a pass. */
  readonly estimateStrength: (secret: string) => Promise<PasswordStrength | null>;
  /** Resolves `true` once the vault exists on disk. */
  readonly onCreateVault: (secret: string) => Promise<boolean>;
  readonly onVaultCreated: () => void;
  /** Rendered only when the host has somewhere to send them. */
  readonly onOpenGenerator?: () => void;
  readonly busy: boolean;
  readonly error: string | null;
}

/** Long enough that a dictionary pass is not run per keystroke; short enough to feel live. */
const STRENGTH_DEBOUNCE_MS = 200;

export function MasterPasswordStep({
  vaultPath,
  acknowledged,
  onAcknowledgedChange,
  estimateStrength,
  onCreateVault,
  onVaultCreated,
  onOpenGenerator,
  busy,
  error,
}: MasterPasswordStepProps): React.JSX.Element {
  const [masterSecret, setMasterSecret] = useState('');
  const [confirmSecret, setConfirmSecret] = useState('');
  const [reveal, setReveal] = useState(false);
  const [strength, setStrength] = useState<PasswordStrength | null>(null);

  /*
   * Debounced for two reasons at once. The estimator matches dictionaries, keyboard
   * patterns and dates, which is not free; and a strength word that changes on every
   * keystroke is announced on every keystroke, which turns a helpful readout into a screen
   * reader talking over the user mid-word. Waiting for the typing to settle fixes both.
   *
   * The empty case clears through the same timer rather than synchronously in the effect
   * body — a synchronous setState there is the cascading-render pattern React warns about,
   * and one code path cannot disagree with itself about what "current" means.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      if (masterSecret === '') {
        setStrength(null);
        return;
      }
      void estimateStrength(masterSecret).then(setStrength);
    }, STRENGTH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [masterSecret, estimateStrength]);

  const draft = { secret: masterSecret, confirmSecret, acknowledged, strength, busy };
  const blocker = masterPasswordBlocker(draft);
  const ready = canCreateVault(draft);
  const mismatch = confirmSecret !== '' && confirmSecret !== masterSecret;

  /*
   * One sentence, used in two places: as the field's `aria-describedby` hint, and as the
   * content of the polite live region below. Written once so the spoken and the visible
   * answer to "how am I doing" can never disagree.
   *
   * It carries no threshold number. The floor lives in `src/main/session/strength.ts` and
   * repeating "at least 12 characters" here would be a second copy of a security constant
   * that this file has no way to read.
   */
  const strengthSummary =
    strength === null
      ? 'A passphrase of four or five unrelated words is easier to remember and much harder to guess than a short complicated one.'
      : `Strength: ${strength.label}. ${
          strength.meetsMasterMinimum
            ? 'Strong enough to protect a vault.'
            : 'Not yet strong enough to protect a vault.'
        }`;

  const submit = (): void => {
    if (!ready) return;
    void onCreateVault(masterSecret).then((created) => {
      if (!created) return;
      // Cleared the instant the vault exists. React keeps component state alive across a
      // step change, and leaving the master password sitting in it afterwards would be a
      // needless second copy of the one value that must not linger.
      setMasterSecret('');
      setConfirmSecret('');
      setReveal(false);
      onVaultCreated();
    });
  };

  return (
    <form
      className="kh-onb__body"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="kh-onb__lead">
        This is the only password you have to remember. It unlocks everything else, and Keyhold
        never stores it — it derives a key from it each time you unlock.
      </p>

      {error !== null && (
        <p className="kh-screen__error" role="alert">
          {error}
        </p>
      )}

      <Input
        label="Master password"
        type={reveal ? 'text' : 'password'}
        value={masterSecret}
        // No `autoFocus`: the flow moves focus to the step heading on every transition, and
        // two things calling focus() in one commit is a race. Tab from the heading lands
        // here.
        autoComplete="new-password"
        secret={reveal}
        disabled={busy}
        onChange={(event) => {
          setMasterSecret(event.target.value);
        }}
        hint={strengthSummary}
        trailing={
          <Button
            variant="ghost"
            size="sm"
            // The accessible name states what pressing it will do, and changes with the
            // state — "Show the password" on a field that is already showing is a lie a
            // screen-reader user has no way to check.
            iconOnlyLabel={reveal ? 'Hide the password' : 'Show the password'}
            onClick={() => {
              setReveal(!reveal);
            }}
          >
            {reveal ? '🙈' : '👁'}
          </Button>
        }
      />

      {/* Announced only once the typing has settled and an estimate has actually arrived,
          so it reports a result rather than narrating the keyboard. */}
      <p className="kh-visually-hidden" aria-live="polite">
        {strength === null ? '' : strengthSummary}
      </p>

      {strength !== null && <StrengthReadout strength={strength} />}

      <Input
        label="Confirm master password"
        type={reveal ? 'text' : 'password'}
        value={confirmSecret}
        autoComplete="new-password"
        secret={reveal}
        disabled={busy}
        onChange={(event) => {
          setConfirmSecret(event.target.value);
        }}
        {...(mismatch ? { error: 'The two passwords do not match.' } : {})}
      />

      <details className="kh-onb__help">
        <summary>How do I choose one I will actually remember?</summary>
        <ul className="kh-onb__help-list">
          <li>
            <strong>Use a passphrase, not a password.</strong> Four or five unrelated words —
            something like <em>copper-lantern-drift-oyster</em> — beats a short string of symbol
            substitutions on both counts: harder to guess, easier to recall.
          </li>
          <li>
            <strong>Make it unique to Keyhold.</strong> A password you already use somewhere else
            has already been in somebody else&rsquo;s breach dump.
          </li>
          <li>
            <strong>Avoid anything about you.</strong> Names, birthdays, pets and addresses are the
            first things guessed, and the estimator above will say so.
          </li>
          <li>
            <strong>Write it down.</strong> Genuinely. A note in a drawer defends against forgetting
            — which is the failure that actually happens — and Keyhold&rsquo;s threat model does not
            assume an attacker in your house.
          </li>
        </ul>
        {onOpenGenerator !== undefined && (
          <Button variant="ghost" size="sm" onClick={onOpenGenerator}>
            Open the password generator
          </Button>
        )}
      </details>

      {/*
       * A real checkbox in a real label, not a styled div: it is reachable by Tab, toggled
       * by Space, announced with its state, and understood by every assistive technology
       * without a single ARIA attribute. Anything reimplemented here would be worse.
       */}
      <label className="kh-ack kh-onb__ack">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={busy}
          onChange={(event) => {
            onAcknowledgedChange(event.target.checked);
          }}
        />
        <span>
          <strong>{NO_RECOVERY_HEADING}</strong>
          <small>{NO_RECOVERY_EXPLANATION}</small>
          <span className="kh-onb__ack-confirm">{NO_RECOVERY_ACKNOWLEDGEMENT}</span>
        </span>
      </label>

      <div className="kh-onb__actions">
        <Button variant="primary" type="submit" disabled={!ready} loading={busy}>
          Create my vault
        </Button>
        {/* Never a mystery-disabled button. The reason is on screen, and it is the reason
            the user should fix first rather than the last condition that failed. */}
        {blocker !== null && (
          <p className="kh-onb__blocker" aria-live="polite">
            {blocker}
          </p>
        )}
      </div>

      {vaultPath !== null && (
        <p className="kh-onb__note">
          Your vault file will be created at <code className="kh-path">{vaultPath}</code>
        </p>
      )}
    </form>
  );
}
