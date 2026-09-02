// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '../components/Button.js';
import { initialFocusTarget, restoreFocus } from './focus.js';
import './chrome.css';

/**
 * A modal dialog, built on the native `<dialog>` element.
 *
 * ## Why `<dialog>` rather than a hand-rolled overlay
 *
 * Keyhold ships one rendering engine. There is no cross-browser argument to weigh, which
 * removes the only real reason people still hand-roll this, and the native element then
 * gives four things that are genuinely difficult to reproduce:
 *
 * - **The top layer.** `showModal()` paints above everything regardless of stacking
 *   context, so there is no z-index number to keep ahead of the next component. A dialog
 *   rendered behind the pane that opened it is the classic failure this removes.
 * - **Real inertness.** Everything outside the dialog becomes inert — not reachable by
 *   Tab, not reachable by a screen reader's virtual cursor, not clickable. A JavaScript
 *   focus trap only ever fakes the first of those; the other two need `aria-hidden`
 *   applied to every sibling of every ancestor, which is exactly the code that rots.
 * - **`::backdrop`**, so the scrim is one CSS rule rather than an extra element.
 * - **Escape**, without a document-level key listener that has to know whether some other
 *   overlay is on top of it.
 *
 * ## Where we deliberately override the native behaviour
 *
 * `open` is a controlled prop, so the dialog must never close itself. The native Escape
 * path closes the element directly, which would leave the DOM closed while React still
 * believes it is open — the next `open={true}` render would then do nothing at all. So the
 * `cancel` event is prevented and routed through `requestClose()` instead, and the parent
 * decides.
 *
 * Escape therefore reaches us twice in Chromium: once as the keydown handled here, once as
 * the dialog's own cancel. `requestClose` is idempotent per open cycle, so that is fine and
 * the keydown path also keeps Escape working in environments without the native element.
 */

export interface ModalProps {
  readonly open: boolean;
  readonly title: string;
  /** A sentence under the title, wired up as the dialog's accessible description. */
  readonly description?: string;
  readonly onClose: () => void;
  readonly children?: ReactNode;
  /** Buttons. Laid out end-aligned; put the primary action last. */
  readonly footer?: ReactNode;
  readonly size?: 'sm' | 'md' | 'lg';
  /** Clicking the backdrop closes. Off for anything with unsaved input in it. */
  readonly closeOnBackdropClick?: boolean;
  /** CSS selector, resolved inside the dialog, for the control that takes first focus. */
  readonly initialFocusSelector?: string;
  /** Hides the corner close button — for a confirm, where the footer already has Cancel. */
  readonly hideCloseButton?: boolean;
}

/**
 * Open the element modally.
 *
 * The fallback exists because jsdom implements `<dialog>` as a plain element with no
 * `showModal`. It is reachable only in a test environment; a packaged build always takes
 * the native path. Note that the fallback gives **no inertness** — that is a property of
 * the top layer, and nothing here can substitute for it.
 */
function openDialog(dialog: HTMLDialogElement): void {
  if (dialog.open) return;
  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
    return;
  }
  dialog.setAttribute('open', '');
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (!dialog.open) return;
  if (typeof dialog.close === 'function') {
    dialog.close();
    return;
  }
  dialog.removeAttribute('open');
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  size = 'md',
  closeOnBackdropClick = true,
  initialFocusSelector,
  hideCloseButton = false,
}: ModalProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closing = useRef(false);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;

  /** One close per open cycle, however many paths ask for it. */
  const requestClose = useCallback((): void => {
    if (closing.current) return;
    closing.current = true;
    onClose();
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || !open) return;

    closing.current = false;

    // Captured before the dialog takes focus, because after that `document.activeElement`
    // is inside the dialog and the trail back to the opener is gone.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    openDialog(dialog);
    initialFocusTarget(dialog, initialFocusSelector).focus();

    return () => {
      closeDialog(dialog);
      // Runs on close *and* on unmount, which is the case that is usually missed: a dialog
      // whose parent route changes underneath it would otherwise leave focus on a detached
      // node, dropping a keyboard user silently back to the top of the document.
      restoreFocus(opener);
    };
  }, [open, initialFocusSelector]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const onCancel = (event: Event): void => {
      event.preventDefault();
      requestClose();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
    };
  }, [requestClose]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className={`kh-modal kh-modal--${size}`}
      // Implied by a dialog in the top layer, but stated anyway: some assistive tech still
      // reads the attribute rather than inferring the state, and an unstated modal is one
      // a screen-reader user can wander out of without realising.
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description !== undefined ? descriptionId : undefined}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        // Stopped here so Escape closes the topmost dialog only, rather than also reaching
        // a parent that would treat it as "cancel the whole flow".
        event.stopPropagation();
        requestClose();
      }}
      onClick={(event) => {
        // A click on the backdrop is reported with the dialog itself as the target; a click
        // on anything inside targets that child. Comparing against the panel is the
        // standard way to tell them apart without an extra scrim element.
        if (!closeOnBackdropClick) return;
        if (event.target === dialogRef.current) requestClose();
      }}
    >
      <div className="kh-modal__panel">
        <header className="kh-modal__header">
          <h2 className="kh-modal__title" id={titleId}>
            {title}
          </h2>
          {!hideCloseButton && (
            <Button
              className="kh-modal__close"
              variant="ghost"
              size="sm"
              icon="✕"
              iconOnlyLabel={`Close: ${title}`}
              onClick={requestClose}
            />
          )}
        </header>

        {description !== undefined && (
          <p className="kh-modal__description" id={descriptionId}>
            {description}
          </p>
        )}

        {children !== undefined && <div className="kh-modal__content">{children}</div>}

        {footer !== undefined && <footer className="kh-modal__footer">{footer}</footer>}
      </div>
    </dialog>
  );
}
