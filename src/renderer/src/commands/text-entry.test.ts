// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import { isTextEntryElement, isTypingInto } from './text-entry.js';

/**
 * The guard that stops a typed password from destroying a record.
 *
 * Everything here is one function and a DOM node, which is the point: the rule is
 * assertable without a React tree, a store or a synthetic key event, so there is no way for
 * it to be "tested" by a test that would pass whatever the function did.
 */

function make(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  const element = host.firstElementChild;
  if (element === null) throw new Error('fixture produced no element');
  document.body.append(host);
  return element;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('isTextEntryElement — things that take typed text', () => {
  it('is true for a bare input', () => {
    expect(isTextEntryElement(make('<input>'))).toBe(true);
  });

  it('is true for a password field, which is the case that matters', () => {
    expect(isTextEntryElement(make('<input type="password">'))).toBe(true);
  });

  it.each(['text', 'search', 'email', 'url', 'tel', 'number', 'date', 'password'])(
    'is true for type="%s"',
    (type) => {
      expect(isTextEntryElement(make(`<input type="${type}">`))).toBe(true);
    }
  );

  it('is true for a textarea', () => {
    expect(isTextEntryElement(make('<textarea></textarea>'))).toBe(true);
  });

  it('is true for a select, which consumes letters as type-ahead', () => {
    expect(isTextEntryElement(make('<select><option>a</option></select>'))).toBe(true);
  });

  it('is true for a contenteditable element', () => {
    expect(isTextEntryElement(make('<div contenteditable="true">x</div>'))).toBe(true);
    expect(isTextEntryElement(make('<div contenteditable="">x</div>'))).toBe(true);
  });

  it('treats an unknown input type as text, which is the safe direction to be wrong in', () => {
    expect(isTextEntryElement(make('<input type="not-a-real-type">'))).toBe(true);
  });
});

describe('isTextEntryElement — things that do not', () => {
  it.each(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset'])(
    'is false for type="%s"',
    (type) => {
      expect(isTextEntryElement(make(`<input type="${type}">`))).toBe(false);
    }
  );

  it('is case-insensitive about the type attribute', () => {
    expect(isTextEntryElement(make('<input type="CHECKBOX">'))).toBe(false);
  });

  it('is false for a button, a link and a plain div', () => {
    expect(isTextEntryElement(make('<button>Go</button>'))).toBe(false);
    expect(isTextEntryElement(make('<a href="#">Go</a>'))).toBe(false);
    expect(isTextEntryElement(make('<div>Go</div>'))).toBe(false);
  });

  it('is false for contenteditable="false"', () => {
    expect(isTextEntryElement(make('<div contenteditable="false">x</div>'))).toBe(false);
  });

  it('is false for null and for a non-element target', () => {
    expect(isTextEntryElement(null)).toBe(false);
    expect(isTextEntryElement(document)).toBe(false);
    expect(isTextEntryElement(window)).toBe(false);
  });
});

describe('isTypingInto — the event target and the focused element', () => {
  it('is true when either one is a text field', () => {
    const field = make('<input>');
    const button = make('<button>Go</button>');

    expect(isTypingInto(field, null)).toBe(true);
    expect(isTypingInto(null, field)).toBe(true);
    expect(isTypingInto(button, field)).toBe(true);
    expect(isTypingInto(button, button)).toBe(false);
  });

  /**
   * The reason both are consulted.
   *
   * A native `<dialog>` moving to the top layer can leave `document.activeElement` behind
   * for a tick. Trusting only the focused element would let a shortcut through during
   * exactly the frame in which a dialog's input has just taken the keystrokes.
   */
  it('is true from the event target alone, before focus has caught up', () => {
    const field = make('<input>');
    const stale = make('<button>Previously focused</button>');
    expect(isTypingInto(field, stale)).toBe(true);
  });
});
