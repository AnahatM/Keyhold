// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import type { ImportSource } from '@shared/model/import-plan.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/Feedback.js';
import { Input } from '../components/Input.js';
import './import.css';

/**
 * Step one: pick a file.
 *
 * There is no path field, and there never will be one. The dialog belongs to the main
 * process — a path the user chose in an OS dialog is an act of consent, a path the renderer
 * supplied is an attacker-controlled string if the renderer is ever compromised. It is the
 * same reasoning as `session.chooseVaultToOpen`, and it is why this step is a button.
 *
 * The warning below the button is not decoration. An export from another password manager is
 * a plaintext copy of everything the user has, sitting in their Downloads folder — the moment
 * to say so is while they are looking at its name, not in a help page.
 *
 * ## The second route, for a Keyhold vault
 *
 * A `.keep` or a `.keepx` needs a passphrase, so it cannot go through the same button — see
 * D30. It is a disclosure rather than a second primary action, because it is the rarer case
 * and because a passphrase field sitting open on a screen the user is not using it on is a
 * field they may type into by mistake.
 *
 * **The plaintext warning does not apply to it, and the copy says so.** Telling somebody to
 * delete an encrypted vault after importing from it would be advice that loses data.
 */
export function ChooseFileStep({
  source,
  busy,
  onChoose,
  onOpenVault,
}: {
  readonly source: ImportSource | null;
  readonly busy: boolean;
  readonly onChoose: () => void;
  readonly onOpenVault: (secretPassphrase: string) => void;
}): React.JSX.Element {
  if (source === null) {
    return (
      <div className="kh-import-step">
        <EmptyState
          icon="📥"
          title="Bring a vault in from somewhere else"
          description="Keyhold reads exports from Bitwarden, LastPass, 1Password, Chrome, Firefox, Safari, Dashlane, NordPass and KeePass — and any other CSV, once you have told it what the columns mean."
          action={
            <Button variant="primary" loading={busy} onClick={onChoose} data-kh-autofocus>
              Choose a file…
            </Button>
          }
        />
        <p className="kh-import-note kh-import-note--warning">
          <span aria-hidden="true">⚠ </span>
          Exports are plaintext. Once the import is finished, delete the file — it is a readable
          copy of every password in it.
        </p>

        <OpenVaultDisclosure busy={busy} onOpenVault={onOpenVault} />
      </div>
    );
  }

  return (
    <div className="kh-import-step">
      <dl className="kh-import-facts">
        <div>
          <dt>File</dt>
          <dd className="kh-import-facts__name">{source.fileName}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{formatBytes(source.sizeBytes)}</dd>
        </div>
        <div>
          <dt>Looks like</dt>
          <dd>
            {source.detectedFormatId ?? 'Nothing recognised — you will choose the format next'}
          </dd>
        </div>
      </dl>

      <Button variant="secondary" loading={busy} onClick={onChoose}>
        Choose a different file…
      </Button>

      <p className="kh-import-note kh-import-note--warning">
        <span aria-hidden="true">⚠ </span>
        Exports are plaintext. Delete this file once the import is finished.
      </p>
    </div>
  );
}

/**
 * Importing from another Keyhold vault or parcel.
 *
 * Collapsed by default. A passphrase field standing open on the file step is a field somebody
 * types their master password into while meaning to pick a CSV — and a passphrase typed into
 * the wrong box is one that has been in a place it should not have been.
 *
 * The value is held for exactly as long as the disclosure is open, and cleared the moment it
 * is submitted or closed. It is never put in a descriptor, an error or a log; the main
 * process uses it once and drops it (D30).
 */
function OpenVaultDisclosure({
  busy,
  onOpenVault,
}: {
  readonly busy: boolean;
  readonly onOpenVault: (secretPassphrase: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [secretPassphrase, setSecretPassphrase] = useState('');

  const close = (): void => {
    setSecretPassphrase('');
    setOpen(false);
  };

  if (!open) {
    return (
      <p className="kh-import-note">
        Importing from another Keyhold vault?{' '}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(true);
          }}
        >
          Open a .keep or .keepx
        </Button>
      </p>
    );
  }

  return (
    <div className="kh-import-vault">
      <p className="kh-import-note">
        A vault or a parcel, opened with its own passphrase — not this vault&rsquo;s. Its records
        come in through the same dry run, duplicate check and undo as any other import.
      </p>

      <Input
        label="The other vault's passphrase"
        type="password"
        autoComplete="off"
        value={secretPassphrase}
        autoFocus
        hint="Used once, to decrypt the file. It is never stored, and never leaves this computer."
        onChange={(event) => {
          setSecretPassphrase(event.target.value);
        }}
      />

      <div className="kh-import-vault__actions">
        <Button
          variant="primary"
          loading={busy}
          disabled={secretPassphrase === ''}
          onClick={() => {
            // Copied out and the field emptied before the call, not after: a failure must not
            // leave a passphrase sitting in component state behind an error banner.
            const attempt = secretPassphrase;
            setSecretPassphrase('');
            onOpenVault(attempt);
          }}
        >
          Choose a vault file…
        </Button>
        <Button variant="secondary" onClick={close} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * A file size a person can read.
 *
 * Binary units with the decimal names people actually recognise. Precision beyond one decimal
 * place is noise here — the number exists so the user can tell "that is my export" from "that
 * is the wrong file", not to audit anything.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}
