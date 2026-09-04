// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useId, useRef } from 'react';
import { Button } from '../components/Button.js';
import { initialFocusTarget, restoreFocus } from './focus.js';
import './lightbox.css';

/**
 * A focused overlay for looking at one image larger.
 *
 * ## It is the same idiom as `Modal`, deliberately
 *
 * Native `<dialog>` + `showModal()`, for the four reasons written out in full in
 * `Modal.tsx`: the top layer removes the z-index race, real inertness that a JavaScript
 * focus trap can only fake, `::backdrop` instead of a scrim element, and Escape without a
 * document-level key listener. There is no second overlay mechanism in this app and this
 * component does not introduce one — it reuses `initialFocusTarget` and `restoreFocus` from
 * `focus.js` too, so "where does focus go" has one answer rather than two.
 *
 * The one shape it does **not** copy is the controlled `open` prop. A lightbox has no
 * partially-open state worth modelling and nothing to preserve between openings, so the
 * caller renders it to open it and stops rendering it to close it. `open` on `Modal` exists
 * because a dialog's contents are often a form mid-edit; there is no equivalent here.
 * Mount-to-open also means the blob URL's lifetime and the overlay's lifetime are the same
 * conditional in the caller, which is the safer coupling.
 *
 * ## It is always opened from inside something else, which is the interesting part
 *
 * The lightbox is reached from an attachment preview that is *already* inside a `Modal`. So
 * this component is a dialog nested inside a dialog, and both the keydown and the click that
 * dismiss it bubble through the parent's handlers on the way out. `Modal` closes on Escape
 * and (by default) on a click that targets its own dialog element.
 *
 * Both are therefore stopped here. Escape must close the topmost surface only — otherwise
 * one press closes the lightbox *and* the viewer behind it, and a user who wanted to go back
 * to the file list finds themselves two screens further out than they asked for. The click
 * is stopped for the same reason plus one more: the caller's own row or button handler is an
 * ancestor of this markup, and an un-stopped dismiss click can reach it and immediately
 * reopen what it just closed.
 *
 * This mirrors `Modal`'s reasoning exactly; it just has more to protect, because a lightbox
 * is never the outermost thing on screen.
 *
 * ## What it is not allowed to do
 *
 * It does not fetch, decode, decrypt, or hold anything. It is handed a URL its caller
 * already made — see `AttachmentViewer.tsx` for the argument about why a preview blob is an
 * acceptable exception at all, and for the `revokeObjectURL` that must accompany it. That
 * revoke is the caller's, because the caller owns the URL.
 *
 * `src` is consequently treated as opaque and write-only: it is set on the image and put
 * nowhere else — no title, no caption, no `aria-label`, no log line. A blob URL is a live
 * handle to decrypted bytes and it does not belong in anything a user can read, copy, or
 * screenshot. `Lightbox.test.tsx` asserts that mechanically rather than trusting review.
 */

export interface LightboxProps {
  /**
   * The image to show. A URL the caller created and will revoke — typically a `blob:` URL
   * from `URL.createObjectURL`. Treated as opaque; never rendered as text.
   */
  readonly src: string;
  /**
   * What the image is. Used as the image's `alt`, as the overlay's accessible name, and as
   * the visible caption — one string, because for an attachment all three are the filename
   * and three props would only invite them to disagree.
   */
  readonly label: string;
  readonly onClose: () => void;
}

/**
 * Open the element modally.
 *
 * Same fallback as `Modal.openDialog`, and for the same reason: jsdom implements `<dialog>`
 * as a plain element with no `showModal`. The fallback path gives **no inertness and no top
 * layer** — those are properties of the real element — so it is a test affordance only, and
 * a packaged build never takes it.
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

export function Lightbox({ src, label, onClose }: LightboxProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closing = useRef(false);
  const baseId = useId();
  const captionId = `${baseId}-caption`;

  /**
   * One close per mount, however many paths ask for it.
   *
   * In Chromium, Escape arrives twice — once as the keydown below, once as the element's own
   * `cancel` event — and a caller whose `onClose` pops a stack or fires an undo toast would
   * see that twice. `Modal` guards the same way.
   */
  const requestClose = useCallback((): void => {
    if (closing.current) return;
    closing.current = true;
    onClose();
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;

    // Captured before the dialog takes focus: afterwards `document.activeElement` is inside
    // the lightbox and the trail back to the control that opened it is gone.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    openDialog(dialog);
    initialFocusTarget(dialog).focus();

    return () => {
      closeDialog(dialog);
      // Runs on unmount, which for this component is *every* close. Without it, focus is
      // left on a detached node and falls silently to <body> — which for a lightbox opened
      // from inside a modal means the keyboard user lands outside the modal they are still
      // in, with no indication anything moved.
      restoreFocus(opener);
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    // The native Escape path closes the element directly. Routing it through `requestClose`
    // instead keeps the DOM and React agreeing about what is on screen, and keeps the single
    // close path that `closing` guards.
    const onCancel = (event: Event): void => {
      event.preventDefault();
      requestClose();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
    };
  }, [requestClose]);

  return (
    <dialog
      ref={dialogRef}
      className="kh-lightbox"
      // Implied by the top layer, but stated: some assistive tech reads the attribute rather
      // than inferring the state, and an unstated modal is one a screen-reader user can
      // wander out of without realising.
      aria-modal="true"
      aria-labelledby={captionId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        // Stopped so Escape closes the topmost surface only. Without this, one press also
        // reaches the `Modal` this lightbox is rendered inside and closes the viewer too.
        event.stopPropagation();
        requestClose();
      }}
      onClick={(event) => {
        // A click on the scrim is reported with the dialog itself as the target; a click on
        // the image or the caption targets that child. Comparing against the dialog is how
        // `Modal` tells them apart, and it needs no extra scrim element.
        if (event.target !== dialogRef.current) return;
        // Stopped for the same reason as Escape, plus the ancestor click handler in the
        // caller — the row or thumbnail that opened this — which would otherwise see the
        // dismiss click and reopen what it just closed.
        event.stopPropagation();
        requestClose();
      }}
    >
      {/*
        `secondary`, not the `ghost` a modal's corner close uses. Ghost is transparent with
        `text-muted`, which is a pair only checked against the panel surfaces it normally
        sits on; here the button floats over the scrim, where that pair is neither checked
        nor legible. Secondary is opaque `surface-raised` + `text` — a declared contrast
        requirement — so the control stays readable and this file restates no colour.
      */}
      <Button
        className="kh-lightbox__close"
        variant="secondary"
        size="sm"
        icon="close"
        iconOnlyLabel={`Close: ${label}`}
        onClick={requestClose}
      />

      <figure className="kh-lightbox__figure">
        {/*
          `alt` is the label, which for an attachment is the filename: the only true thing
          that can be said about an image nobody has described, and better than an empty
          string, which announces nothing at all. Same call as `AttachmentViewer` makes.
        */}
        <img className="kh-lightbox__image" src={src} alt={label} />
        {/* Selectable, so the filename can be copied; the app disables selection globally. */}
        <figcaption className="kh-lightbox__caption" id={captionId} data-selectable="true">
          {label}
        </figcaption>
      </figure>
    </dialog>
  );
}
