// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * When a tooltip is allowed to appear.
 *
 * Separated from the component because the interesting part is not the markup, it is the
 * timing — and the timing is what makes a tooltip either helpful or a screen full of
 * flickering boxes.
 *
 * Three rules:
 *
 * **A pointer merely passing through opens nothing.** {@link TOOLTIP_OPEN_DELAY_MS} of
 * rest on the trigger is required first. Crossing a toolbar on the way to somewhere else
 * should not light up six tooltips in sequence.
 *
 * **Keyboard focus opens immediately.** A keyboard user did not stumble onto the control;
 * they deliberately tabbed to it. Making them wait half a second for information a mouse
 * user gets for hovering is a worse experience for the user with fewer options, and the
 * delay would also mean `aria-describedby` pointed at nothing during the moment the
 * screen reader is actually reading the control.
 *
 * **A group stays warm.** Once one tooltip has been shown, the next one within
 * {@link TOOLTIP_WARM_WINDOW_MS} opens instantly. Someone comparing three toolbar buttons
 * has already demonstrated they want the labels; re-serving the delay each time reads as
 * the app being slow.
 */

/** How long the pointer must rest before a cold tooltip opens. */
export const TOOLTIP_OPEN_DELAY_MS = 500;

/**
 * Grace period before a tooltip closes after the pointer leaves.
 *
 * Not politeness — WCAG 2.2 SC 1.4.13 requires the content to be *hoverable*, which means
 * the pointer has to be able to travel from the trigger onto the tooltip without it
 * disappearing en route.
 */
export const TOOLTIP_CLOSE_DELAY_MS = 140;

/** After a tooltip closes, the next one in the group opens with no delay for this long. */
export const TOOLTIP_WARM_WINDOW_MS = 400;

export type TooltipTrigger = 'pointer' | 'focus';

/**
 * The shared warmth of a set of tooltips.
 *
 * A group rather than a global so tests do not have to reset module state between cases,
 * and so a future surface with its own timing (a dense table, say) can have one.
 */
export interface TooltipGroup {
  /** Milliseconds to wait before showing, for a trigger arriving at `now`. */
  readonly openDelayMs: (trigger: TooltipTrigger, now: number) => number;
  /** Record that a tooltip has just closed, which starts the warm window. */
  readonly noteClosed: (now: number) => void;
  /** Forget the warm window — used when a surface that owns tooltips goes away. */
  readonly reset: () => void;
}

/**
 * The delay decision, as a pure function of the last close.
 *
 * Exported separately from the group so the rule can be asserted without a mutable object
 * in the way.
 */
export function openDelayMs(
  trigger: TooltipTrigger,
  lastClosedAt: number | null,
  now: number
): number {
  if (trigger === 'focus') return 0;
  if (lastClosedAt !== null && now - lastClosedAt <= TOOLTIP_WARM_WINDOW_MS) return 0;
  return TOOLTIP_OPEN_DELAY_MS;
}

export function createTooltipGroup(): TooltipGroup {
  let lastClosedAt: number | null = null;
  return {
    openDelayMs: (trigger, now) => openDelayMs(trigger, lastClosedAt, now),
    noteClosed: (now) => {
      lastClosedAt = now;
    },
    reset: () => {
      lastClosedAt = null;
    },
  };
}

/** The group every `Tooltip` uses unless it is given another. */
export const defaultTooltipGroup: TooltipGroup = createTooltipGroup();
