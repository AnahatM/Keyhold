// SPDX-License-Identifier: GPL-3.0-or-later

import { Button } from '../components/Button.js';
import { Modal } from './Modal.js';

/**
 * A confirm, with a real distinction between "are you sure" and "this destroys data".
 *
 * Three things change when `destructive` is set, because **colour alone is not a warning**
 * (WCAG 1.4.1) and a red button is the only thing most confirm dialogs actually change:
 *
 * 1. **A named consequence in words** — "This cannot be undone" — sits above the buttons
 *    with a warning symbol. Someone who cannot distinguish the red still reads the
 *    sentence.
 * 2. **Focus opens on Cancel, not on Confirm.** A confirm that appears with the destructive
 *    button already focused turns a reflexive Enter into deletion. This is the single
 *    highest-value line in the file.
 * 3. **The button says the verb** — "Delete permanently", not "OK". A label the user can
 *    read out of context is the last chance to notice they are on the wrong dialog.
 *
 * The backdrop does not dismiss a destructive confirm. A stray click landing outside the
 * panel should not resolve a question about data loss in either direction — and since the
 * backdrop can only ever mean "cancel", removing it costs nothing while removing a way to
 * dismiss the dialog without having read it.
 */

/** Resolved inside the dialog by `Modal`'s `initialFocusSelector`. */
const CANCEL_SELECTOR = '.kh-confirm__cancel';
const CONFIRM_SELECTOR = '.kh-confirm__confirm';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  /** What is about to happen, in one sentence. Name the thing, not "this item". */
  readonly message: string;
  /**
   * The confirm button's label. Make it the verb: "Delete permanently", "Move to Trash",
   * "Replace 12 credentials".
   */
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  /**
   * The consequence, spelled out. Defaults to a sentence for destructive confirms and is
   * omitted otherwise.
   */
  readonly consequence?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** Disables both buttons and marks the confirm busy while the action runs. */
  readonly busy?: boolean;
}

const DEFAULT_DESTRUCTIVE_CONSEQUENCE = 'This cannot be undone.';

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  consequence,
  onConfirm,
  onCancel,
  busy = false,
}: ConfirmDialogProps): React.JSX.Element | null {
  const spelledOut = consequence ?? (destructive ? DEFAULT_DESTRUCTIVE_CONSEQUENCE : undefined);

  return (
    <Modal
      open={open}
      title={title}
      description={message}
      onClose={onCancel}
      size="sm"
      closeOnBackdropClick={!destructive}
      initialFocusSelector={destructive ? CANCEL_SELECTOR : CONFIRM_SELECTOR}
      hideCloseButton
      footer={
        <>
          <Button
            className="kh-confirm__cancel"
            variant="secondary"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </Button>
          <Button
            className="kh-confirm__confirm"
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {spelledOut !== undefined && (
        <p
          className={`kh-confirm__consequence${destructive ? ' kh-confirm__consequence--destructive' : ''}`}
        >
          <span className="kh-confirm__symbol" aria-hidden="true">
            ⚠
          </span>
          {spelledOut}
        </p>
      )}
    </Modal>
  );
}
