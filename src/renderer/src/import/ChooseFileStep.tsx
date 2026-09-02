// SPDX-License-Identifier: GPL-3.0-or-later
import type { ImportSource } from '@shared/model/import-plan.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/Feedback.js';
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
 */
export function ChooseFileStep({
  source,
  busy,
  onChoose,
}: {
  readonly source: ImportSource | null;
  readonly busy: boolean;
  readonly onChoose: () => void;
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
