// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Focus bookkeeping for overlay surfaces.
 *
 * Deliberately small. The modal in this folder uses the native `<dialog>` element, and
 * `showModal()` already puts the dialog in the top layer and makes the rest of the
 * document inert — so the *trap* is the platform's job, not ours (see `Modal.tsx` for the
 * full reasoning). What the platform does not reliably do for us is choose a sensible
 * first focus and put focus back where it came from, and those two are what live here.
 *
 * They are plain DOM functions rather than hooks so the ordering rules — which element
 * wins initial focus, what happens when the opener has gone from the document — can be
 * asserted directly.
 */

/**
 * Selector for things a user can tab to.
 *
 * `[tabindex]:not([tabindex="-1"])` rather than `[tabindex]`, because a `-1` element is
 * programmatically focusable but not part of the tab order, and treating it as the first
 * stop would drop the user somewhere they could not have reached themselves.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Marks the control that should receive focus when a surface opens.
 *
 * Used instead of the `autofocus` attribute: `autofocus` fires once, at parse time, which
 * is the wrong moment for a dialog that mounts and re-opens repeatedly.
 */
export const AUTOFOCUS_ATTRIBUTE = 'data-kh-autofocus';

function isDisabled(element: Element): boolean {
  return element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';
}

/**
 * Every tabbable descendant, in tab order.
 *
 * Visibility is checked with `hidden` and `aria-hidden` rather than computed styles: this
 * has to work in jsdom, where layout does not exist and every `offsetParent` is null, so a
 * geometry-based check would silently report that nothing is focusable at all.
 */
export function getFocusable(container: ParentNode): readonly HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !isDisabled(element) && !element.hidden && element.closest('[aria-hidden="true"]') === null
  );
}

/**
 * The element that should hold focus when a surface opens.
 *
 * Order: an explicit `selector` supplied by the caller, then `data-kh-autofocus`, then the
 * first tabbable control, then the container itself. The last fallback matters — a dialog
 * with nothing focusable inside still has to take focus, or the user is left with focus on
 * an inert document behind a modal and no way to reach either.
 *
 * The `selector` escape hatch exists for one specific case: a **destructive** confirm must
 * open with focus on Cancel, not on the button that destroys data, so that a reflexive
 * Enter or Space does nothing. See `ConfirmDialog.tsx`.
 */
export function initialFocusTarget(container: HTMLElement, selector?: string): HTMLElement {
  if (selector !== undefined) {
    const requested = container.querySelector<HTMLElement>(selector);
    if (requested !== null && !isDisabled(requested)) return requested;
  }
  const explicit = container.querySelector<HTMLElement>(`[${AUTOFOCUS_ATTRIBUTE}]`);
  if (explicit !== null && !isDisabled(explicit)) return explicit;
  return getFocusable(container)[0] ?? container;
}

/**
 * Give focus back to whatever opened the surface.
 *
 * The guard is the whole point. An opener can be gone by the time the dialog closes — the
 * row it lived in was the row just deleted — and focusing a detached node silently moves
 * focus to `<body>`, which drops a keyboard user back at the top of the app with no
 * indication anything happened. Falling back to a named element keeps them near where they
 * were.
 *
 * Returns the element that ended up focused, or `null` if nothing could be.
 */
export function restoreFocus(
  opener: HTMLElement | null,
  fallback: HTMLElement | null = null
): HTMLElement | null {
  if (opener?.isConnected === true) {
    opener.focus();
    return opener;
  }
  if (fallback?.isConnected === true) {
    fallback.focus();
    return fallback;
  }
  return null;
}
