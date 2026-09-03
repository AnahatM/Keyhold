// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Lightbox } from './Lightbox.js';
import { Modal } from './Modal.js';
import { mountReact } from './test-dom.js';

/**
 * The lightbox behaviours that cannot be asserted against a pure function, and that break
 * silently when they regress.
 *
 * Two of them exist only because a lightbox is **never the outermost surface**: it is opened
 * from an attachment preview that is already a `Modal`, so every dismissal has to stop at
 * the lightbox instead of continuing outward. Those two render the real nesting rather than
 * a stand-in parent, because the bug they catch is specifically an interaction between the
 * two components.
 *
 * One is a security guard: the `src` is a live handle to decrypted attachment bytes, and the
 * test walks the rendered DOM to prove it reached the image and nothing else.
 *
 * jsdom does not implement `HTMLDialogElement.showModal`, so these run against the
 * documented fallback path. The focus *trap* is therefore not covered — it is the platform's,
 * a property of the top layer — but the close plumbing and the focus bookkeeping, which are
 * ours, are.
 */

/** An empty arrow body trips no-empty-function; this says the same thing and is allowed. */
const noop = (): void => undefined;

const SRC = 'blob:keyhold/9f2c7a41-preview';
const LABEL = 'passport-scan.png';

function makeOpener(): HTMLButtonElement {
  const opener = document.createElement('button');
  opener.textContent = 'View larger';
  document.body.append(opener);
  opener.focus();
  return opener;
}

function pressEscape(target: Element): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function click(target: Element): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** The lightbox's own dialog. Selected by class, because a `Modal` may wrap it. */
function lightboxOf(container: HTMLElement): HTMLDialogElement {
  const dialog = container.querySelector<HTMLDialogElement>('dialog.kh-lightbox');
  expect(dialog, 'the lightbox dialog is in the document').not.toBeNull();
  return dialog!;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Lightbox', () => {
  it('closes on Escape, exactly once', () => {
    const onClose = vi.fn();
    makeOpener();
    const tree = mountReact(<Lightbox src={SRC} label={LABEL} onClose={onClose} />);

    const dialog = lightboxOf(tree.container);
    pressEscape(dialog);
    // Escape reaches the component twice in a real browser — once as this keydown, once as
    // the dialog's own cancel event. A close is idempotent per mount.
    pressEscape(dialog);

    expect(onClose).toHaveBeenCalledTimes(1);
    tree.unmount();
  });

  it('closes on a click on the scrim, but not on a click on the image', () => {
    const onClose = vi.fn();
    makeOpener();
    const tree = mountReact(<Lightbox src={SRC} label={LABEL} onClose={onClose} />);
    const dialog = lightboxOf(tree.container);

    click(dialog.querySelector('img')!);
    expect(
      onClose,
      'clicking the image is looking at it, not dismissing it'
    ).not.toHaveBeenCalled();

    click(dialog.querySelector('figcaption')!);
    expect(onClose, 'the caption is content too').not.toHaveBeenCalled();

    click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);

    tree.unmount();
  });

  it('does not close the modal it was opened from — Escape', () => {
    // The failure this exists for: one Escape closes the lightbox *and* the attachment
    // viewer behind it, dropping the user two screens further out than they asked for.
    const onLightboxClose = vi.fn();
    const onModalClose = vi.fn();
    makeOpener();

    const tree = mountReact(<Modal open title="passport-scan.png" onClose={onModalClose} />);
    // Rendered in a second pass, which is how it actually happens: the viewer is already
    // open and mounted when the user asks for a larger view.
    tree.render(
      <Modal open title="passport-scan.png" onClose={onModalClose}>
        <Lightbox src={SRC} label={LABEL} onClose={onLightboxClose} />
      </Modal>
    );

    pressEscape(lightboxOf(tree.container));

    expect(onLightboxClose).toHaveBeenCalledTimes(1);
    expect(onModalClose, 'the viewer behind stays open').not.toHaveBeenCalled();

    tree.unmount();
  });

  it('does not let a dismiss click reach the handlers it is nested inside', () => {
    // The click half of the same bug, rendered in the real composition: viewer modal →
    // the caller's own markup → lightbox. The assertion that discriminates is the caller's
    // handler; an un-stopped dismiss click reaches it and reopens what it just closed.
    //
    // `onModalClose` rides along as documentation of the composition rather than as the
    // guard — `Modal` closes only on a click whose target *is* its own dialog element, and
    // a click on the lightbox's scrim never is, so no bug in this file can make that
    // assertion fail. It is stated because a reader will otherwise ask, and answering it
    // in a comment is cheaper than an assertion that could never fire.
    const onLightboxClose = vi.fn();
    const onModalClose = vi.fn();
    const onCallerClick = vi.fn();
    makeOpener();

    const tree = mountReact(<Modal open title="passport-scan.png" onClose={onModalClose} />);
    tree.render(
      <Modal open title="passport-scan.png" onClose={onModalClose}>
        <div onClick={onCallerClick}>
          <Lightbox src={SRC} label={LABEL} onClose={onLightboxClose} />
        </div>
      </Modal>
    );

    click(lightboxOf(tree.container));

    expect(onLightboxClose).toHaveBeenCalledTimes(1);
    expect(onCallerClick, "the caller's handler must not see the dismiss").not.toHaveBeenCalled();
    expect(onModalClose, 'the viewer behind stays open').not.toHaveBeenCalled();

    tree.unmount();
  });

  it('takes focus when it opens and gives it back when it closes', () => {
    const opener = makeOpener();
    const tree = mountReact(<Lightbox src={SRC} label={LABEL} onClose={noop} />);

    const dialog = lightboxOf(tree.container);
    expect(dialog.contains(document.activeElement), 'focus moved into the lightbox').toBe(true);

    // Closing a lightbox *is* unmounting it — there is no `open` prop to flip.
    tree.unmount();

    expect(document.activeElement).toBe(opener);
  });

  it('names itself with the label, for assistive tech and for the image', () => {
    makeOpener();
    const tree = mountReact(<Lightbox src={SRC} label={LABEL} onClose={noop} />);
    const dialog = lightboxOf(tree.container);

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(document.getElementById(labelId ?? '')?.textContent).toBe(LABEL);
    expect(dialog.querySelector('img')?.getAttribute('alt')).toBe(LABEL);

    tree.unmount();
  });

  it('puts the source on the image and nowhere else', () => {
    // The guard for the rule in the component's header. A `blob:` URL is a live handle to
    // decrypted attachment bytes; it must not become something a user can read, copy, hover
    // or screenshot. A `title={src}` or a debug caption added later fails here rather than
    // in a review nobody ran.
    makeOpener();
    const tree = mountReact(<Lightbox src={SRC} label={LABEL} onClose={noop} />);
    const dialog = lightboxOf(tree.container);

    const carriers: string[] = [];
    for (const element of [dialog, ...dialog.querySelectorAll('*')]) {
      for (const attribute of element.attributes) {
        if (attribute.value.includes(SRC)) {
          carriers.push(`${element.tagName.toLowerCase()}@${attribute.name}`);
        }
      }
    }

    expect(carriers).toEqual(['img@src']);
    expect(dialog.textContent, 'the URL is never rendered as text').not.toContain(SRC);

    tree.unmount();
  });
});
