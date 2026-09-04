// SPDX-License-Identifier: GPL-3.0-or-later
import { Button } from '../components/Button.js';
import { ENCRYPTION_CLAIM } from './onboarding-copy.js';
import '../vault/vault-screens.css';
import './onboarding.css';
import { Icon } from '../components/Icon.js';

/**
 * Where the vault lives, and the one sentence about backing it up.
 *
 * This step exists because of a failure mode that has nothing to do with attackers:
 * **people lose vaults to disk failure and to deleted folders far more often than to
 * anyone trying to break in.** "Your data is in a file" is the product's best property and
 * its sharpest edge, and someone who has used a hosted password manager has never once had
 * to think about where their passwords physically are.
 *
 * So it shows the real path, says plainly what the file is, and gives exactly one
 * instruction about copies. One — not a backup strategy, not a 3-2-1 lecture. A single
 * sentence someone might act on beats a checklist nobody finishes.
 *
 * It comes after the vault is created rather than before, so it can point at something that
 * exists rather than describing something that is going to.
 */
export function VaultFileStep({
  vaultPath,
  onRevealInFolder,
  onContinue,
}: {
  readonly vaultPath: string | null;
  /** Opens the containing folder. Rendered only when the host can actually do it. */
  readonly onRevealInFolder?: () => void;
  readonly onContinue: () => void;
}): React.JSX.Element {
  return (
    <div className="kh-onb__body">
      <p className="kh-onb__lead">
        Your vault exists now. It is one file, and everything you put in Keyhold lives inside it.
      </p>

      {vaultPath !== null && (
        <div className="kh-onb__path">
          <span className="kh-onb__path-label">Your vault file</span>
          {/* Selectable: copying the path is the most likely thing someone wants from this
              screen, and a path is not secret — it is on the user's own disk. */}
          <code className="kh-path" data-selectable="true">
            {vaultPath}
          </code>
          {onRevealInFolder !== undefined && (
            <Button variant="ghost" size="sm" onClick={onRevealInFolder}>
              Show it in my file manager
            </Button>
          )}
        </div>
      )}

      <ul className="kh-onb__facts">
        <li>
          <span className="kh-onb__fact-mark" aria-hidden="true">
            <Icon name="shield" size="lg" />
          </span>
          <span>
            <strong>It is encrypted, not hidden.</strong> {ENCRYPTION_CLAIM}
          </span>
        </li>
        <li>
          <span className="kh-onb__fact-mark" aria-hidden="true">
            <Icon name="parcel" size="lg" />
          </span>
          <span>
            <strong>It travels.</strong> Put it in a cloud folder, on a USB stick or on another
            machine and open it there — a sync service only ever sees the encrypted file.
          </span>
        </li>
        <li>
          <span className="kh-onb__fact-mark" aria-hidden="true">
            <Icon name="save" size="lg" />
          </span>
          <span>
            <strong>Keep a copy somewhere else.</strong> A drive that fails takes this file with it,
            and there is no copy on a server to fall back on. One backup, anywhere that is not this
            computer, is the whole job.
          </span>
        </li>
      </ul>

      <p className="kh-onb__note">
        Keyhold also keeps a few recent versions beside the file and writes changes in a way that
        cannot leave it half-saved — but those live on the same disk, so they are not a substitute
        for a copy elsewhere.
      </p>

      <div className="kh-onb__actions">
        <Button variant="primary" onClick={onContinue}>
          Got it
        </Button>
      </div>
    </div>
  );
}
