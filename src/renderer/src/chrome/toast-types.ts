// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The toast vocabulary.
 *
 * Split from the reducer so the reducer file is arithmetic and policy only, and so a
 * component can name a toast type without pulling the queue machinery in with it.
 *
 * Two shapes, deliberately different:
 *
 * `ToastInput` is what a caller writes — everything optional that can reasonably default.
 * `Toast` is the normalised internal record — nothing optional, absent values are `null`.
 *
 * The reason for that split is `exactOptionalPropertyTypes`: with optional properties, a
 * record built by spreading a partial is a running argument with the type checker about
 * whether "absent" and "undefined" are the same thing. Normalising to `null` at the door
 * means the reducer never has to ask.
 */

/**
 * Tone carries meaning, never decoration.
 *
 * It drives three things at once — the colour, the symbol shown beside the title, and the
 * live-region politeness. They are one decision, which is why they are one field.
 */
export type ToastTone = 'success' | 'info' | 'warning' | 'error';

export interface ToastAction {
  readonly label: string;
  readonly onAct: () => void;
}

export interface ToastInput {
  /** Defaults to `info`. */
  readonly tone?: ToastTone;
  /** The whole message for most toasts. Keep it to a line. */
  readonly title: string;
  readonly description?: string;
  /**
   * Repeated toasts sharing a key collapse into one, with a repeat count.
   *
   * This is what keeps "Copied" from stacking twenty deep when someone leans on the copy
   * shortcut. Give a key to anything a user can trigger in a burst.
   */
  readonly dedupeKey?: string;
  /**
   * Milliseconds on screen, or `null` to stay until dismissed.
   *
   * Leave it unset. The default is derived from the toast itself — see
   * `defaultDurationMs` in `toast-queue.ts`, which is where the undo rule lives.
   */
  readonly durationMs?: number | null;
  /**
   * The undo affordance. "Moved to Trash — Undo".
   *
   * Giving a toast an action changes its lifetime: see `defaultDurationMs`.
   */
  readonly action?: ToastAction;
}

/** A normalised toast. Absent values are `null`, never `undefined`. */
export interface Toast {
  readonly id: string;
  readonly tone: ToastTone;
  readonly title: string;
  readonly description: string | null;
  readonly dedupeKey: string | null;
  readonly action: ToastAction | null;
  /** `null` means it never expires on its own. */
  readonly durationMs: number | null;
  /**
   * How many times this message has arrived, counting the first. Rendered as "×3".
   *
   * A count is more honest than silently swallowing the repeats: the user pressed the
   * key three times and deserves to see that all three landed.
   */
  readonly repeatCount: number;
  /**
   * The absolute epoch-ms moment it disappears — not a duration counted down.
   *
   * A ticking `remaining--` gives two sources of truth that drift apart the moment a
   * render is skipped or a tab is throttled, and it forces a state write per frame. An
   * absolute deadline is compared, not maintained. Same reasoning as the unlock lockout
   * countdown in `UnlockScreen.tsx`.
   *
   * `null` while paused, or when `durationMs` is `null`.
   */
  readonly expiresAt: number | null;
  /** What is left of the clock while paused. `null` while running. */
  readonly remainingMs: number | null;
}

/**
 * Why the countdown is stopped.
 *
 * Reasons rather than a boolean because they overlap: the pointer can leave a toast that
 * still holds keyboard focus, and the window can be hidden underneath both. A boolean
 * would let whichever event fires last resume a toast the user is still reading.
 */
export type ToastPauseReason = 'pointer' | 'focus' | 'window-hidden';

export interface ToastState {
  /** On screen, oldest first. Capped — see `MAX_VISIBLE_TOASTS`. */
  readonly visible: readonly Toast[];
  /** Waiting for a slot, oldest first. Capped — see `MAX_QUEUED_TOASTS`. */
  readonly queued: readonly Toast[];
  /** Non-empty means every visible countdown is stopped. */
  readonly pauseReasons: readonly ToastPauseReason[];
}

export type ToastEvent =
  | { readonly type: 'push'; readonly toast: Toast; readonly now: number }
  | { readonly type: 'dismiss'; readonly id: string; readonly now: number }
  /** Sweep expired toasts and promote from the queue. Driven by one timer. */
  | { readonly type: 'reap'; readonly now: number }
  | { readonly type: 'pause'; readonly reason: ToastPauseReason; readonly now: number }
  | { readonly type: 'resume'; readonly reason: ToastPauseReason; readonly now: number }
  | { readonly type: 'clear' };
