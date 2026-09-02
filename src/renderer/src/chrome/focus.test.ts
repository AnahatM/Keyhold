// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import { AUTOFOCUS_ATTRIBUTE, getFocusable, initialFocusTarget, restoreFocus } from './focus.js';

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('getFocusable', () => {
  it('returns tabbable controls in tab order', () => {
    const host = mount('<a href="#a">a</a><button>b</button><input /><textarea></textarea>');
    expect(getFocusable(host).map((element) => element.tagName)).toEqual([
      'A',
      'BUTTON',
      'INPUT',
      'TEXTAREA',
    ]);
  });

  it('skips a disabled control', () => {
    const host = mount('<button disabled>no</button><button>yes</button>');
    expect(getFocusable(host)).toHaveLength(1);
  });

  it('skips tabindex="-1", which is focusable but not tabbable', () => {
    // Landing a user on one would drop them somewhere they could not have tabbed to
    // themselves, and could not tab back out of in the direction they came from.
    const host = mount('<div tabindex="-1">pane</div><button>real</button>');
    expect(getFocusable(host).map((element) => element.tagName)).toEqual(['BUTTON']);
  });

  it('skips anything inside an aria-hidden subtree', () => {
    const host = mount('<div aria-hidden="true"><button>ghost</button></div><button>real</button>');
    expect(getFocusable(host)).toHaveLength(1);
  });
});

describe('initialFocusTarget', () => {
  it('prefers the caller’s selector — this is how a destructive confirm opens on Cancel', () => {
    const host = mount(
      '<button class="confirm">Delete</button><button class="cancel">Cancel</button>'
    );
    expect(initialFocusTarget(host, '.cancel').textContent).toBe('Cancel');
  });

  it('falls back to the autofocus marker, then to the first control', () => {
    const marked = mount(`<button>first</button><button ${AUTOFOCUS_ATTRIBUTE}>marked</button>`);
    expect(initialFocusTarget(marked).textContent).toBe('marked');

    const plain = mount('<button>first</button><button>second</button>');
    expect(initialFocusTarget(plain).textContent).toBe('first');
  });

  it('falls back to the container when nothing inside can take focus', () => {
    // A dialog that takes no focus at all leaves the user on an inert document behind it,
    // able to reach neither the dialog nor the page.
    const host = mount('<p>Nothing here is focusable.</p>');
    expect(initialFocusTarget(host)).toBe(host);
  });
});

describe('restoreFocus', () => {
  it('returns focus to the element that opened the surface', () => {
    const host = mount('<button id="opener">Open</button>');
    const opener = host.querySelector<HTMLElement>('#opener')!;

    expect(restoreFocus(opener)).toBe(opener);
    expect(document.activeElement).toBe(opener);
  });

  it('does not focus an opener that has been removed from the document', () => {
    // The row that opened the confirm is the row the confirm just deleted. Focusing the
    // detached node silently sends focus to <body>, which is indistinguishable from the app
    // losing the user's place entirely.
    const host = mount('<button id="opener">Delete</button>');
    const opener = host.querySelector<HTMLElement>('#opener')!;
    const fallback = mount('<button id="list">Credential list</button>').querySelector<HTMLElement>(
      '#list'
    )!;
    opener.remove();

    expect(restoreFocus(opener, fallback)).toBe(fallback);
    expect(document.activeElement).toBe(fallback);
  });

  it('reports that it could not restore rather than pretending it did', () => {
    const orphan = document.createElement('button');
    expect(restoreFocus(orphan)).toBeNull();
  });
});
