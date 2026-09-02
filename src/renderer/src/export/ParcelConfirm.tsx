// SPDX-License-Identifier: GPL-3.0-or-later

import { useState } from 'react';
import type { ExportLoss } from '@shared/model/export.js';
import type { PasswordStrength } from '@shared/model/strength.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { LossList } from './LossList.js';
import { PassphraseStrength } from './PassphraseStrength.js';
import './export.css';

/**
 * The safe path: a `.keepx` parcel, sealed under a passphrase of its own.
 *
 * ## Two things this screen has to say out loud
 *
 * **The passphrase is not the master password, and Keyhold does not keep it.** A parcel is
 * a separate KEEP container with its own salt and its own key; there is no recovery, no
 * second copy, and no way for this app to open the file later on the user's behalf. A
 * passphrase typed here and forgotten takes the parcel with it.
 *
 * **Whoever receives the file needs it, and it must not travel with the file.** The single
 * most common way an encrypted transfer fails is the passphrase being mailed in the reply
 * underneath the attachment, which reduces the whole exercise to a slower plaintext export.
 * Saying so is cheap; not saying so has a real failure mode.
 *
 * The passphrase is entered twice because there is nothing to check it against later — the
 * file cannot be opened without it, so a typo is not discovered until the parcel is needed.
 * And it is gated on strength for the same reason the vault is: a parcel under `1234` is a
 * plaintext export with extra steps.
 */
export interface ParcelConfirmProps {
  readonly passphrase: string;
  readonly repeat: string;
  readonly strength: PasswordStrength | null;
  readonly losses: readonly ExportLoss[];
  readonly onPassphraseChange: (typed: string) => void;
  readonly onRepeatChange: (typed: string) => void;
}

export function ParcelConfirm({
  passphrase,
  repeat,
  strength,
  losses,
  onPassphraseChange,
  onRepeatChange,
}: ParcelConfirmProps): React.JSX.Element {
  const [reveal, setReveal] = useState(false);
  const mismatch = repeat !== '' && repeat !== passphrase;
  const weak = strength !== null && !strength.meetsMasterMinimum && passphrase !== '';

  return (
    <div className="kh-export-confirm">
      <div className="kh-export-note kh-export-note--info">
        <p>
          <strong>This file is sealed under a passphrase of its own.</strong> It is not your master
          password, Keyhold does not store it, and nothing can open the parcel without it.
        </p>
        <p>
          Whoever you send the file to needs this passphrase — send it a different way, not in the
          same message as the file.
        </p>
      </div>

      <Input
        label="Passphrase for this parcel"
        type={reveal ? 'text' : 'password'}
        value={passphrase}
        autoComplete="new-password"
        secret={reveal}
        autoFocus
        onChange={(event) => {
          onPassphraseChange(event.target.value);
        }}
        hint="Several unrelated words are easier to pass on over the phone and harder to guess than one complicated word."
        trailing={
          <Button
            variant="ghost"
            size="sm"
            iconOnlyLabel={reveal ? 'Hide the passphrase' : 'Show the passphrase'}
            onClick={() => {
              setReveal(!reveal);
            }}
          >
            {reveal ? '🙈' : '👁'}
          </Button>
        }
      />

      {strength !== null && <PassphraseStrength strength={strength} />}

      <Input
        label="Type it again"
        type={reveal ? 'text' : 'password'}
        value={repeat}
        autoComplete="new-password"
        secret={reveal}
        onChange={(event) => {
          onRepeatChange(event.target.value);
        }}
        {...(mismatch ? { error: 'The two passphrases do not match.' } : {})}
      />

      {weak && (
        <p className="kh-export-note kh-export-note--warning" role="status">
          <span aria-hidden="true">⚠ </span>
          This passphrase is not strong enough to be the only thing protecting a copy of your
          records. Keyhold asks for at least twelve characters and something that is not a
          predictable pattern.
        </p>
      )}

      <section className="kh-export-section">
        <h4 className="kh-export-section__heading">What this file will not carry</h4>
        <LossList
          losses={losses}
          emptyNote="Nothing is left out. The parcel carries every field, every version and every origin of the records you chose."
        />
      </section>
    </div>
  );
}
