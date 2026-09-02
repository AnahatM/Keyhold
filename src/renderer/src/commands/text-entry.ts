// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * "Is the user typing into something?"
 *
 * The single most important guard in the shortcut system, and the one with the worst
 * failure mode: someone is typing a master password into a field, one of the characters
 * happens to be bound to "move to trash", and a record disappears. The shortcut handler
 * asks this before doing anything, and only a shortcut explicitly marked `whileTyping`
 * gets past a `true`.
 *
 * ## Why the type list is a list of what is *not* text
 *
 * `<input>` covers both text entry and a pile of things that are not — checkboxes, radios,
 * buttons, sliders, colour wells, file pickers. Enumerating the text types instead would
 * mean this predicate silently returning `false` for every input type added to HTML after
 * it was written, which is the wrong way round: an unknown input type is far more likely
 * to be a text field than a button, and being wrong in that direction only costs a
 * shortcut that did not fire.
 *
 * Pure and DOM-only — no React, no store, no shortcut vocabulary — so the whole truth
 * table can be asserted directly.
 */

/**
 * `<input type>` values that take no typed text.
 *
 * `hidden` is here for completeness; it cannot hold focus. `submit`, `reset` and `button`
 * are buttons wearing an input's tag, and a shortcut absolutely should fire while one of
 * them has focus.
 */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/**
 * Whether this element consumes typed characters.
 *
 * `select` counts. It does not take free text, but it does consume single letters as
 * type-ahead, and a shortcut stealing a keystroke there is the same class of surprise.
 *
 * `contentEditable` is read through `isContentEditable` where the DOM offers it and
 * through the attribute otherwise, because jsdom does not implement the property — and a
 * guard that silently degrades to "nothing is editable" under test is a guard whose tests
 * prove nothing.
 */
export function isTextEntryElement(node: EventTarget | null): boolean {
  if (!(node instanceof Element)) return false;

  const tag = node.tagName.toLowerCase();

  if (tag === 'textarea' || tag === 'select') return true;

  if (tag === 'input') {
    const type = (node.getAttribute('type') ?? 'text').toLowerCase();
    if (NON_TEXT_INPUT_TYPES.has(type)) return false;
    // A disabled or read-only field cannot receive the keystroke either, but it also
    // cannot hold focus in the disabled case, and a read-only field is still a field a
    // user is interacting with. Left as text on purpose.
    return true;
  }

  if (node instanceof HTMLElement && node.isContentEditable) return true;

  const editable = node.getAttribute('contenteditable');
  return editable !== null && editable !== 'false';
}

/**
 * Whether anything in the document is currently taking typed text.
 *
 * Uses the event's own target in preference to `document.activeElement`. They are normally
 * the same, but inside a native `<dialog>` in the top layer — which is what every overlay
 * in this app is — `activeElement` can lag by a tick after the dialog opens, and a guard
 * that is wrong for one tick is wrong exactly when a dialog has just taken focus.
 */
export function isTypingInto(target: EventTarget | null, active: Element | null): boolean {
  return isTextEntryElement(target) || isTextEntryElement(active);
}
