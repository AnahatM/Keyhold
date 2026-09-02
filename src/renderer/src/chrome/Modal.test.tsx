// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal.js';
import { mountReact } from './test-dom.js';

/** An empty arrow body trips no-empty-function; this says the same thing and is allowed. */
const noop = (): void => undefined;

/**
 * The two modal behaviours that cannot be asserted against a pure function, and that break
 * silently when they regress: Escape, and where focus goes afterwards.
 *
 * jsdom does not implement `HTMLDialogElement.showModal`, so these run against `Modal`'s
 * documented fallback path. That means the *trap* itself is not covered here — it is the
 * platform's, provided by the top layer — but the controlled-close plumbing and the focus
 * bookkeeping, which are ours, are.
 */

function makeOpener(): HTMLButtonElement {
  const opener = document.createElement('button');
  opener.textContent = 'Open';
  document.body.append(opener);
  opener.focus();
  return opener;
}

function pressEscape(target: Element): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Modal', () => {
  it('takes focus into the dialog when it opens', () => {
    makeOpener();
    const tree = mountReact(
      <Modal open title="Rename folder" onClose={noop}>
        <input aria-label="Name" />
      </Modal>
    );

    const dialog = tree.container.querySelector('dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.contains(document.activeElement)).toBe(true);

    tree.unmount();
  });

  it('honours initialFocusSelector — how a destructive confirm opens on Cancel', () => {
    makeOpener();
    const tree = mountReact(
      <Modal
        open
        title="Delete credential"
        onClose={noop}
        initialFocusSelector=".target"
        footer={
          <>
            <button type="button">Delete permanently</button>
            <button type="button" className="target">
              Cancel
            </button>
          </>
        }
      />
    );

    expect(document.activeElement?.textContent).toBe('Cancel');
    tree.unmount();
  });

  it('closes on Escape, exactly once', () => {
    const onClose = vi.fn();
    makeOpener();
    const tree = mountReact(<Modal open title="Rename folder" onClose={onClose} />);

    const dialog = tree.container.querySelector('dialog')!;
    pressEscape(dialog);
    // Escape reaches the component twice in a real browser — once as this keydown, once as
    // the dialog's own cancel event. A close is idempotent per open cycle.
    pressEscape(dialog);

    expect(onClose).toHaveBeenCalledTimes(1);
    tree.unmount();
  });

  it('gives focus back to whatever opened it', () => {
    const opener = makeOpener();
    const tree = mountReact(<Modal open title="Rename folder" onClose={noop} />);
    expect(document.activeElement).not.toBe(opener);

    tree.render(<Modal open={false} title="Rename folder" onClose={noop} />);

    expect(document.activeElement).toBe(opener);
    tree.unmount();
  });

  it('gives focus back when it is unmounted rather than closed', () => {
    // The case that is usually missed: the route changes underneath an open dialog. Without
    // the cleanup, focus is left on a detached node and silently falls to <body>.
    const opener = makeOpener();
    const tree = mountReact(<Modal open title="Rename folder" onClose={noop} />);
    tree.unmount();

    expect(document.activeElement).toBe(opener);
  });

  it('renders nothing at all while closed', () => {
    const tree = mountReact(<Modal open={false} title="Rename folder" onClose={noop} />);
    expect(tree.container.querySelector('dialog')).toBeNull();
    tree.unmount();
  });

  it('labels and describes itself for assistive tech', () => {
    makeOpener();
    const tree = mountReact(
      <Modal open title="Delete credential" description="GitHub — anahat" onClose={noop} />
    );

    const dialog = tree.container.querySelector('dialog')!;
    const labelId = dialog.getAttribute('aria-labelledby');
    const describedId = dialog.getAttribute('aria-describedby');

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(labelId ?? '')?.textContent).toBe('Delete credential');
    expect(document.getElementById(describedId ?? '')?.textContent).toBe('GitHub — anahat');

    tree.unmount();
  });
});
