// SPDX-License-Identifier: GPL-3.0-or-later

import type { PointerEvent as ReactPointerEvent, FocusEvent as ReactFocusEvent } from 'react';
import { ToastItem } from './ToastItem.js';
import { politenessFor } from './toast-context.js';
import type { Toast, ToastPauseReason } from './toast-types.js';

/**
 * Where toasts are drawn, and the only place the pause rules live.
 *
 * ## Two live regions, not one
 *
 * A live region's politeness is fixed on the container — it cannot vary per message. So
 * announcing errors assertively and everything else politely (see `politenessFor`) needs
 * two containers, and each toast renders into the one matching its tone. One region with
 * `aria-live` flipped per message does not work: assistive tech reads the attribute when
 * the region is created, not when the text changes.
 *
 * ## Pausing
 *
 * WCAG 2.2 SC 2.2.1 requires a time limit to be pausable, and an undo that expires while
 * someone is still reading it is the concrete version of that rule. Three things stop the
 * clock, tracked as separate reasons so that whichever one ends last does not resume a
 * toast another is still holding:
 *
 * - **the pointer is over the stack** — the obvious one;
 * - **focus is inside the stack** — the one that is usually forgotten, and without which
 *   a keyboard user tabbing to "Undo" watches it vanish under their hands;
 * - **the window is hidden** — handled in the provider. A toast that lives out its five
 *   seconds behind another window was never shown at all.
 */

export interface ToastViewportProps {
  readonly toasts: readonly Toast[];
  /** How many are waiting for a slot. Rendered as a quiet "+2 more". */
  readonly queuedCount: number;
  readonly onDismiss: (id: string) => void;
  readonly onPause: (reason: ToastPauseReason) => void;
  readonly onResume: (reason: ToastPauseReason) => void;
}

/** True when a pointer/focus event genuinely left the container rather than moving inside it. */
function leftContainer(
  event: ReactPointerEvent<HTMLElement> | ReactFocusEvent<HTMLElement>
): boolean {
  const related = event.relatedTarget;
  if (!(related instanceof Node)) return true;
  return !event.currentTarget.contains(related);
}

export function ToastViewport({
  toasts,
  queuedCount,
  onDismiss,
  onPause,
  onResume,
}: ToastViewportProps): React.JSX.Element {
  const assertive = toasts.filter((toast) => politenessFor(toast.tone) === 'assertive');
  const polite = toasts.filter((toast) => politenessFor(toast.tone) === 'polite');

  return (
    <div
      className="kh-toasts"
      role="region"
      aria-label="Notifications"
      // `pointerover`/`pointerout` rather than enter/leave: enter and leave do not bubble,
      // in React or natively, and the toasts themselves are the only descendants that
      // receive pointer events — the container is transparent to the pointer so it does not
      // swallow clicks on the app underneath it.
      onPointerOver={() => {
        onPause('pointer');
      }}
      onPointerOut={(event) => {
        if (leftContainer(event)) onResume('pointer');
      }}
      onFocus={() => {
        onPause('focus');
      }}
      onBlur={(event) => {
        if (leftContainer(event)) onResume('focus');
      }}
    >
      <ol
        className="kh-toasts__region"
        aria-live="assertive"
        aria-atomic="false"
        // Additions only. With `text` included, coalescing a repeat would re-read every
        // toast in the region rather than just the one that changed.
        aria-relevant="additions"
        aria-label="Errors"
      >
        {assertive.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </ol>

      <ol
        className="kh-toasts__region"
        aria-live="polite"
        aria-atomic="false"
        aria-relevant="additions"
        aria-label="Messages"
      >
        {polite.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </ol>

      {queuedCount > 0 && (
        // Hidden from assistive tech on purpose: every queued toast is announced in full
        // the moment it is promoted, so reading the counter as well would say everything
        // twice. The number is here for the sighted user, who otherwise cannot tell that
        // the stack is capped rather than finished.
        <p className="kh-toasts__queued" aria-hidden="true">
          +{queuedCount} more
        </p>
      )}
    </div>
  );
}
