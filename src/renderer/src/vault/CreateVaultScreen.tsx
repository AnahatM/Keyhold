// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import type { PasswordStrength } from '@shared/model/strength.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { StrengthReadout } from '../components/StrengthReadout.js';
import { useSession } from './session-store.js';
import './vault-screens.css';

/**
 * Creating a vault.
 *
 * The screen is built around one uncomfortable fact that most password managers soften and
 * this one states outright: **there is no recovery**. Nobody can open the vault without
 * this password — not the maintainer, not a support address, not a recovery email. That is
 * the whole security model, and burying it in small print would be a kindness that costs
 * someone their entire vault later.
 *
 * So it is an explicit checkbox rather than a line of text. A checkbox forces a deliberate
 * act, and someone who ticks it without reading has at least been given the chance that
 * fine print does not.
 */
export function CreateVaultScreen(): React.JSX.Element {
  const { workingPath, busy, error, createVault, goTo, estimateStrength } = useSession();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [strength, setStrength] = useState<PasswordStrength | null>(null);

  /*
   * Debounced, so a dictionary-matching pass is not run on every keystroke and the meter
   * does not flicker mid-word.
   *
   * The empty case clears via the same timer rather than synchronously in the effect body:
   * a synchronous setState there is the cascading-render pattern React warns about, and
   * routing both paths through the timeout keeps this to one code path instead of two that
   * can disagree about what "current" means.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      if (password === '') {
        setStrength(null);
        return;
      }
      void estimateStrength(password).then(setStrength);
    }, 180);
    return () => {
      clearTimeout(timer);
    };
  }, [password, estimateStrength]);

  const mismatch = confirm !== '' && confirm !== password;
  const strongEnough = strength?.meetsMasterMinimum === true;
  const canCreate =
    !busy && password !== '' && password === confirm && acknowledged && strongEnough;

  const submit = (): void => {
    if (!canCreate) return;
    void createVault(password).then((created) => {
      if (created) {
        // Clearing on success matters: React keeps component state alive across a screen
        // change, and leaving the master password sitting in it after the vault is open
        // would be a needless copy of the one thing that must not linger.
        setPassword('');
        setConfirm('');
      }
    });
  };

  return (
    <div className="kh-screen">
      <form
        className="kh-screen__panel"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <header className="kh-screen__header">
          <h1 className="kh-screen__title">Create a vault</h1>
          {workingPath !== null && (
            <p className="kh-screen__subtitle">
              Saving to <code className="kh-path">{workingPath}</code>
            </p>
          )}
        </header>

        {error !== null && (
          <p className="kh-screen__error" role="alert">
            {error}
          </p>
        )}

        <Input
          label="Master password"
          type={reveal ? 'text' : 'password'}
          value={password}
          autoFocus
          autoComplete="new-password"
          secret={reveal}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          hint="A long passphrase of unrelated words is easier to remember and harder to guess than a short complicated one."
          trailing={
            <Button
              variant="ghost"
              size="sm"
              iconOnlyLabel={reveal ? 'Hide the password' : 'Show the password'}
              onClick={() => {
                setReveal(!reveal);
              }}
            >
              {reveal ? '🙈' : '👁'}
            </Button>
          }
        />

        {strength !== null && <StrengthReadout strength={strength} />}

        <Input
          label="Confirm master password"
          type={reveal ? 'text' : 'password'}
          value={confirm}
          autoComplete="new-password"
          secret={reveal}
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
              Keyhold has no account, no server and no reset link. If you forget this password, the
              vault and everything in it is gone permanently. Write it down and keep it somewhere
              safe.
            </small>
          </span>
        </label>

        <div className="kh-screen__actions">
          <Button variant="primary" type="submit" disabled={!canCreate} loading={busy}>
            Create vault
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              goTo('welcome');
            }}
          >
            Cancel
          </Button>
        </div>

        {password !== '' && !strongEnough && strength !== null && (
          <p className="kh-screen__note">
            This password is not strong enough to protect a vault. Keyhold asks for at least 12
            characters and a password that is not a predictable pattern.
          </p>
        )}
      </form>
    </div>
  );
}

/**
 * The strength meter.
 *
 * Shows the score as a bar **and** a word, never colour alone (WCAG 1.4.1) — and the word
 * comes first, because "Weak" is unambiguous in a way a shade of orange is not.
 */
