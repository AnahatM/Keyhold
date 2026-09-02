// SPDX-License-Identifier: GPL-3.0-or-later

import { Button } from '../components/Button.js';
import type { Toast, ToastTone } from './toast-types.js';

/**
 * One toast.
 *
 * Purely presentational — it owns no timer and no state. Everything about when it appears
 * and when it leaves is decided by the reducer in `toast-queue.ts`, which is what makes the
 * timing testable without rendering anything.
 */

/**
 * A visible shape per tone, so the meaning does not live in the colour alone (WCAG 1.4.1).
 *
 * A colour-blind user, a user on a monochrome display, and a user who has replaced the
 * palette with their own custom theme all get the same signal from these glyphs.
 */
const TONE_SYMBOL: Readonly<Record<ToastTone, string>> = {
  success: '✓',
  info: 'i',
  warning: '!',
  error: '✕',
};

/**
 * Spoken before the message, so an announcement begins "Error, could not save" rather than
 * leaving the tone to a colour a screen-reader user cannot see.
 */
const TONE_WORD: Readonly<Record<ToastTone, string>> = {
  success: 'Success',
  info: 'Information',
  warning: 'Warning',
  error: 'Error',
};

export interface ToastItemProps {
  readonly toast: Toast;
  readonly onDismiss: (id: string) => void;
}

export function ToastItem({ toast, onDismiss }: ToastItemProps): React.JSX.Element {
  const dismiss = (): void => {
    onDismiss(toast.id);
  };

  const act = (): void => {
    toast.action?.onAct();
    // The toast goes as soon as the action is taken. Leaving an "Undo" button sitting there
    // after the undo has happened invites a second press, and a second undo is a redo of the
    // deletion — which is the exact data loss the undo existed to prevent.
    dismiss();
  };

  return (
    <li className={`kh-toast kh-toast--${toast.tone}`}>
      <span className="kh-toast__symbol" aria-hidden="true">
        {TONE_SYMBOL[toast.tone]}
      </span>

      <div className="kh-toast__body">
        <p className="kh-toast__title">
          <span className="kh-visually-hidden">{TONE_WORD[toast.tone]}: </span>
          {toast.title}
          {toast.repeatCount > 1 && (
            <>
              {' '}
              <span className="kh-toast__count" aria-hidden="true">
                ×{toast.repeatCount}
              </span>
              <span className="kh-visually-hidden">, repeated {toast.repeatCount} times</span>
            </>
          )}
        </p>
        {toast.description !== null && <p className="kh-toast__description">{toast.description}</p>}
      </div>

      {toast.action !== null && (
        <Button className="kh-toast__action" variant="secondary" size="sm" onClick={act}>
          {toast.action.label}
        </Button>
      )}

      <Button
        className="kh-toast__dismiss"
        variant="ghost"
        size="sm"
        icon="✕"
        // The title is in the label because there can be three of these on screen at once,
        // and "Dismiss, button" three times over tells a screen-reader user nothing about
        // which one they are on.
        iconOnlyLabel={`Dismiss: ${toast.title}`}
        onClick={dismiss}
      />
    </li>
  );
}
