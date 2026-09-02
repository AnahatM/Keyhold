// SPDX-License-Identifier: GPL-3.0-or-later
import { Button } from '../components/Button.js';
import { MODE_DETAILS } from './generator-options.js';
import { formatBits } from './strength-band.js';
import type { SecretHistoryEntry } from './generation-history.js';

/**
 * The last few passwords this panel made.
 *
 * It exists for one moment: you clicked Regenerate once too often and the good one is
 * gone. Without this, the only recovery is to keep clicking and hope.
 *
 * Two constraints it works under:
 *
 * **No accessible name may contain a password.** Each button is named by the entry's
 * *position* — "Copy password 2 from this session" — not by its value. A secret in an
 * `aria-label` or a `title` is a secret in the accessibility tree, which is a place secrets
 * do not belong. The same reason the React key is a counter rather than the value.
 *
 * **The list is session-only and capped.** It is component state, it is cleared when the
 * vault locks, and it dies with the panel. See `generation-history.ts`.
 */

export interface SecretHistoryListProps {
  readonly entries: readonly SecretHistoryEntry[];
  readonly onRestore: (id: string) => void;
  readonly onCopy: (secret: string, position: number) => void;
  readonly onForget: () => void;
}

export function SecretHistoryList({
  entries,
  onRestore,
  onCopy,
  onForget,
}: SecretHistoryListProps): React.JSX.Element | null {
  if (entries.length === 0) return null;

  return (
    <section className="kh-gen-history">
      <header className="kh-gen-history__header">
        <h3 className="kh-gen-history__heading">Earlier in this session</h3>
        <Button variant="ghost" size="sm" onClick={onForget}>
          Forget these
        </Button>
      </header>

      <ol className="kh-gen-history__list">
        {entries.map((entry, index) => {
          const position = index + 1;
          return (
            <li key={entry.id} className="kh-gen-history__item">
              <span className="kh-secret kh-gen-history__secret" data-selectable="true">
                {entry.secret}
              </span>
              <span className="kh-gen-history__meta">
                {MODE_DETAILS[entry.mode].label} · {formatBits(entry.entropyBits)} bits
              </span>
              <span className="kh-gen-history__actions">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnlyLabel={`Put password ${position} from this session back on screen`}
                  onClick={() => {
                    onRestore(entry.id);
                  }}
                >
                  ↩
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnlyLabel={`Copy password ${position} from this session`}
                  onClick={() => {
                    onCopy(entry.secret, position);
                  }}
                >
                  ⧉
                </Button>
              </span>
            </li>
          );
        })}
      </ol>

      <p className="kh-gen-history__note">
        Kept only while this panel is open, and cleared when the vault locks. Nothing here is saved
        anywhere.
      </p>
    </section>
  );
}
