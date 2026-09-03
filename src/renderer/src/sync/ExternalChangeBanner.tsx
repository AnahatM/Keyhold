// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useState } from 'react';
import type { VaultChangedExternally } from '@shared/model/vault-change.js';
import { Button } from '../components/Button.js';
import {
  EXTERNAL_CHANGE_LABELS,
  promptForExternalChange,
  type ExternalChangeAction,
} from './external-change.js';
import './sync.css';

/**
 * Tells the user their vault file changed underneath them, and offers only what is safe.
 *
 * A banner rather than a toast or a modal, and each of those is a deliberate no. A toast
 * disappears, and this needs a decision. A modal demands one immediately, which is how people
 * learn to click the first button — and the honest answer to "another device saved this" is
 * often "in a minute", because the two copies are both intact and nothing is being lost while
 * the banner sits there.
 *
 * **Which actions appear is decided in `external-change.ts`, not here.** That split is the
 * point: the wrong offer destroys data silently, and a decision table can be tested over every
 * combination of the flags, where a component test would only prove that a button rendered.
 *
 * Subscribes for as long as the vault is open. The event only arrives while one is, because
 * the watcher is armed on unlock and disarmed on lock.
 */

export interface ExternalChangeBannerProps {
  /** Whether this window is holding edits that are not in any file. Decides what is offered. */
  readonly hasUnsavedChanges: boolean;
  readonly onReload: () => void;
  readonly onMerge: () => void;
  readonly onLock: () => void;
  /**
   * Subscribes, and returns its own unsubscribe.
   *
   * Injected rather than reached for through `window.keyhold`, so the component can be driven
   * in a test without a preload bridge — the same arrangement the resolver uses for its
   * gateway.
   */
  readonly subscribe: (listener: (change: VaultChangedExternally) => void) => () => void;
}

export function ExternalChangeBanner({
  hasUnsavedChanges,
  onReload,
  onMerge,
  onLock,
  subscribe,
}: ExternalChangeBannerProps): React.JSX.Element | null {
  const [change, setChange] = useState<VaultChangedExternally | null>(null);

  useEffect(() => {
    // The latest wins. Two writes in a row from a sync client are one situation, not two, and
    // the second report describes it more accurately than the first.
    return subscribe((next) => {
      setChange(next);
    });
    // `subscribe` is rebuilt by the caller on every render; depending on it would tear the
    // subscription down and up on each one, and drop an event landing in between.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = useCallback(() => {
    setChange(null);
  }, []);

  if (change === null) return null;

  const prompt = promptForExternalChange(change, hasUnsavedChanges);

  const run = (action: ExternalChangeAction): void => {
    // Dismissed either way. Every other action either replaces this screen or ends the
    // session, and a banner still describing a situation that has been acted on is worse than
    // no banner — it invites acting on it twice.
    dismiss();
    if (action === 'reload') onReload();
    if (action === 'merge') onMerge();
    if (action === 'lock') onLock();
  };

  return (
    <div
      className={`kh-external-change kh-external-change--${prompt.tone}`}
      // `alert` for the two that are about losing something, `status` for the ordinary case:
      // an assertive live region interrupts whatever a screen reader is saying, which is right
      // for a replaced vault and rude for "another device saved".
      role={prompt.tone === 'info' ? 'status' : 'alert'}
    >
      <div className="kh-external-change__text">
        <p className="kh-external-change__headline">{prompt.headline}</p>
        <p className="kh-external-change__detail">{prompt.detail}</p>
        {prompt.withheld !== undefined && (
          <p className="kh-external-change__withheld">{prompt.withheld}</p>
        )}
      </div>

      <div className="kh-external-change__actions">
        {prompt.actions.map((action, index) => (
          <Button
            key={action}
            size="sm"
            variant={index === 0 ? 'primary' : 'ghost'}
            onClick={() => {
              run(action);
            }}
          >
            {EXTERNAL_CHANGE_LABELS[action]}
          </Button>
        ))}
      </div>
    </div>
  );
}
