// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button.js';
import { KdfProgressBar } from '../vault/KdfProgressBar.js';
import { MergeResolver } from './MergeResolver.js';
import { emptyTargetNames, type MergeTargetNames } from './merge-targets.js';
import type { SyncGateway } from './sync-gateway.js';
import type { KdfProgressView } from '@shared/model/kdf-progress.js';
import type { MergeCommitResult, MergePreview } from '@shared/model/sync-plan.js';
import './sync.css';

/**
 * Everything that happens before the resolver can be rendered.
 *
 * `MergeResolver` takes a prepared `MergePreview` and nothing else — it cannot open a file
 * dialog, cannot decrypt, and does not know that either happens. That is what lets it be
 * driven entirely by a fake gateway in its own tests, and it is why something has to own the
 * step in front of it. This is that something, and it is the only part of the merge flow
 * that is allowed to be slow.
 *
 * `prepare` is one call doing four irreversible-feeling things: the file dialog, an Argon2id
 * decrypt of the other copy, the mandatory pre-merge backup, and the first merge. It is
 * deliberately one call — a user who has picked a file should not be able to end up in a
 * state where the backup was skipped — but it means the window sits here for as long as the
 * KDF takes.
 *
 * **The bar is the same one unlock uses.** It was indeterminate here at first, because there
 * was no KDF progress channel anywhere in the app; building one for merge alone would have
 * been the second list, so it was built where unlock needed it too and this reads the same
 * events. The position is predicted from this machine's previous derivations rather than
 * measured — Argon2 reports nothing of its own — and `kdf-estimate.ts` carries that argument.
 */

export interface MergeFlowProps {
  readonly gateway: SyncGateway;
  /** Names for records, folders and tags. Falls back to ids when the vault list is empty. */
  readonly names?: MergeTargetNames | undefined;
  readonly onClose: () => void;
  /** The vault changed underneath the app; the caller re-reads its projection. */
  readonly onApplied?: ((result: MergeCommitResult) => void) | undefined;
  readonly onOpenRecord?: ((recordId: string) => void) | undefined;
  /**
   * Subscribes to the Argon2 progress estimate for the bar shown while `prepare` runs.
   *
   * A prop rather than a reach for `window.keyhold`, for the same reason `gateway` is one:
   * this component is driven in its own tests with no preload bridge present, and a direct
   * reach turns every one of them into a crash on `window.keyhold` being undefined. It did,
   * once — which is the argument for the injection rather than an argument about it.
   */
  readonly subscribeToKdfProgress: (listener: (progress: KdfProgressView) => void) => () => void;
}

type Phase =
  | { readonly kind: 'preparing' }
  | { readonly kind: 'ready'; readonly preview: MergePreview }
  | { readonly kind: 'failed'; readonly message: string };

export function MergeFlow({
  gateway,
  names,
  onClose,
  onApplied,
  onOpenRecord,
  subscribeToKdfProgress,
}: MergeFlowProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'preparing' });
  const [attempt, setAttempt] = useState(0);

  // Read through a function, never as a bare boolean. TypeScript narrows a `let live = true`
  // to the literal `true` inside the closure below and then reads the guard as dead code,
  // which is how a cancellation check gets quietly deleted by whoever tidies next.
  const liveRef = useRef(true);
  const isLive = useCallback((): boolean => liveRef.current, []);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const preview = await gateway.prepare();

        // Dismissing the file dialog is not an error and not a screen. It means the user
        // changed their mind before anything happened, so the flow simply ends.
        if (preview === null) {
          if (isLive()) onClose();
          return;
        }

        // The gap this closes: the vault locks, or the user cancels, while Argon2 is still
        // running. `prepare` returns a decrypted copy of another whole vault, and by now the
        // component that would have owned it is gone — nothing else knows the plan id, so
        // without this the copy sits in the main process until the next lock.
        //
        // It has to happen *here*, not in this effect's teardown. The teardown runs at
        // unmount, which on this path is before `prepare` has returned anything to discard;
        // an id captured for it is still null when it reads it. That was the first version,
        // and it discarded nothing.
        if (!isLive()) {
          void gateway.discard(preview.planId).catch(() => undefined);
          return;
        }

        // From here the plan belongs to the resolver, which discards it from its own teardown
        // however it closes — applied, cancelled, or unmounted.
        setPhase({ kind: 'ready', preview });
      } catch (error) {
        if (isLive()) {
          setPhase({
            kind: 'failed',
            message: error instanceof Error ? error.message : 'The merge could not be prepared.',
          });
        }
      }
    })();
    // `attempt` is the retry trigger. `gateway` is deliberately absent: it is rebuilt on
    // every render of the caller, and depending on it would re-run the file dialog forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  if (phase.kind === 'preparing') {
    return (
      <div className="kh-merge">
        <div className="kh-merge-preparing">
          <KdfProgressBar label="Reading the other copy" subscribe={subscribeToKdfProgress} />
          <p className="kh-merge-preparing__note">
            Unlocking it with this vault&rsquo;s master password, then backing this one up before
            anything is merged.
          </p>
        </div>
      </div>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <div className="kh-merge">
        <div className="kh-merge-failed" role="alert">
          <h1 className="kh-merge-failed__title">That file could not be merged</h1>
          <p className="kh-merge-failed__detail">{phase.message}</p>
          <p className="kh-merge-failed__hint">
            A merge is between two copies of the same vault, opened with the same master password. A
            different vault, or a file that is not a vault at all, will not open.
          </p>
          <div className="kh-merge-failed__actions">
            <Button
              onClick={() => {
                setPhase({ kind: 'preparing' });
                setAttempt((previous) => previous + 1);
              }}
            >
              Choose another file
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <MergeResolver
      gateway={gateway}
      preview={phase.preview}
      names={names ?? emptyTargetNames()}
      onClose={onClose}
      onApplied={onApplied}
      onOpenRecord={onOpenRecord}
    />
  );
}
