// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountReact } from '../chrome/test-dom.js';
import { useShortcuts, type ShortcutHandlers } from './use-shortcuts.js';
import type { ShortcutScope } from './shortcut-registry.js';

/**
 * The listener itself.
 *
 * `@testing-library/react` is not a dependency and adding one for this would be the wrong
 * trade, so the three behaviours that genuinely cannot be asserted against a pure function
 * are driven through the chrome's own `mountReact` harness: that the listener is removed on
 * unmount, that a real key event reaches the right handler, and that the text-field guard
 * holds against a real focused `<input>`.
 *
 * Everything else about *when* a shortcut fires is `shortcut-gate.test.ts`, against a pure
 * function, which is where it belongs.
 */

interface HarnessProps {
  readonly handlers: ShortcutHandlers;
  readonly locked?: boolean;
  readonly overlayOpen?: boolean;
  readonly scopes?: readonly ShortcutScope[];
  readonly enabled?: boolean;
}

function Harness({
  handlers,
  locked = false,
  overlayOpen = false,
  scopes = ['global', 'list'],
  enabled = true,
}: HarnessProps): React.JSX.Element {
  useShortcuts(handlers, { locked, overlayOpen, scopes, platform: 'win32', enabled });
  return <input data-testid="field" />;
}

function press(key: string, options: Partial<KeyboardEventInit> = {}, target?: Element): void {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  (target ?? document.body).dispatchEvent(event);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the global listener', () => {
  it('runs the handler for a matching combination', () => {
    const openPalette = vi.fn();
    const tree = mountReact(<Harness handlers={{ 'palette.open': openPalette }} />);

    press('k', { ctrlKey: true });
    expect(openPalette).toHaveBeenCalledTimes(1);

    tree.unmount();
  });

  it('ignores a combination nothing is bound to', () => {
    const openPalette = vi.fn();
    const tree = mountReact(<Harness handlers={{ 'palette.open': openPalette }} />);

    press('j', { ctrlKey: true });
    press('k');
    press('k', { ctrlKey: true, shiftKey: true });
    expect(openPalette).not.toHaveBeenCalled();

    tree.unmount();
  });

  /**
   * A key nothing claims must reach the app untouched.
   *
   * Calling `preventDefault` unconditionally is the easy mistake, and it silently breaks
   * every key the handler does not know about — including the ones the OS owns.
   */
  it('does not prevent the default of a key it did not claim', () => {
    const tree = mountReact(<Harness handlers={{ 'palette.open': vi.fn() }} />);

    const unclaimed = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    document.body.dispatchEvent(unclaimed);
    expect(unclaimed.defaultPrevented).toBe(false);

    const claimed = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(claimed);
    expect(claimed.defaultPrevented).toBe(true);

    tree.unmount();
  });

  it('ignores an auto-repeating key so holding one down fires once', () => {
    const openPalette = vi.fn();
    const tree = mountReact(<Harness handlers={{ 'palette.open': openPalette }} />);

    press('k', { ctrlKey: true });
    press('k', { ctrlKey: true, repeat: true });
    press('k', { ctrlKey: true, repeat: true });
    expect(openPalette).toHaveBeenCalledTimes(1);

    tree.unmount();
  });

  /**
   * The listener is removed on unmount.
   *
   * A `window` listener that outlives its component keeps firing forever against a closure
   * from a tree that no longer exists, and accumulates one more copy per mount. The symptom
   * is a shortcut that starts running twice, and it is invisible until it does.
   */
  it('removes its listener on unmount', () => {
    const openPalette = vi.fn();
    const tree = mountReact(<Harness handlers={{ 'palette.open': openPalette }} />);

    press('k', { ctrlKey: true });
    expect(openPalette).toHaveBeenCalledTimes(1);

    tree.unmount();

    press('k', { ctrlKey: true });
    expect(openPalette).toHaveBeenCalledTimes(1);
  });

  it('does not accumulate listeners across remounts', () => {
    const openPalette = vi.fn();
    for (let index = 0; index < 3; index += 1) {
      const tree = mountReact(<Harness handlers={{ 'palette.open': openPalette }} />);
      tree.unmount();
    }

    const tree = mountReact(<Harness handlers={{ 'palette.open': openPalette }} />);
    press('k', { ctrlKey: true });
    expect(openPalette).toHaveBeenCalledTimes(1);
    tree.unmount();
  });

  it('binds nothing at all when disabled', () => {
    const openPalette = vi.fn();
    const tree = mountReact(<Harness enabled={false} handlers={{ 'palette.open': openPalette }} />);

    press('k', { ctrlKey: true });
    expect(openPalette).not.toHaveBeenCalled();

    tree.unmount();
  });
});

describe('the guards, against a real focused field', () => {
  /**
   * The one that matters.
   *
   * A user is typing a password. One of the characters is bound to a destructive shortcut.
   * Nothing may happen.
   */
  it('will not trash a record while a password field has focus', () => {
    const trash = vi.fn();
    const tree = mountReact(<Harness handlers={{ 'credential.trash': trash }} />);

    const field = document.createElement('input');
    field.type = 'password';
    document.body.append(field);
    field.focus();

    press('Backspace', { ctrlKey: true }, field);
    expect(trash).not.toHaveBeenCalled();

    // The same key, with focus somewhere harmless, does fire — so the test above is
    // proving the guard rather than a broken binding.
    field.blur();
    press('Backspace', { ctrlKey: true });
    expect(trash).toHaveBeenCalledTimes(1);

    tree.unmount();
  });

  it('still opens the palette from inside a text field', () => {
    const openPalette = vi.fn();
    const tree = mountReact(<Harness handlers={{ 'palette.open': openPalette }} />);

    const field = document.createElement('input');
    document.body.append(field);
    field.focus();

    press('k', { ctrlKey: true }, field);
    expect(openPalette).toHaveBeenCalledTimes(1);

    tree.unmount();
  });

  it('fires nothing but the help sheet while the vault is locked', () => {
    const openPalette = vi.fn();
    const lock = vi.fn();
    const help = vi.fn();
    const tree = mountReact(
      <Harness
        locked
        handlers={{ 'palette.open': openPalette, 'vault.lock': lock, 'shortcuts.help': help }}
      />
    );

    press('k', { ctrlKey: true });
    press('l', { ctrlKey: true });
    press('/', { ctrlKey: true });

    expect(openPalette).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
    expect(help).toHaveBeenCalledTimes(1);

    tree.unmount();
  });

  it('does not fire a list shortcut when the list scope is not active', () => {
    const edit = vi.fn();
    const tree = mountReact(<Harness scopes={['global']} handlers={{ 'credential.edit': edit }} />);

    press('e', { ctrlKey: true });
    expect(edit).not.toHaveBeenCalled();

    tree.unmount();
  });

  it('leaves background shortcuts alone while an overlay is open', () => {
    const lock = vi.fn();
    const openPalette = vi.fn();
    const tree = mountReact(
      <Harness overlayOpen handlers={{ 'vault.lock': lock, 'palette.open': openPalette }} />
    );

    press('l', { ctrlKey: true });
    press('k', { ctrlKey: true });

    expect(lock).not.toHaveBeenCalled();
    // The palette's own key still toggles it closed.
    expect(openPalette).toHaveBeenCalledTimes(1);

    tree.unmount();
  });
});

describe('the handlers can change without the listener being rebuilt', () => {
  it('calls the latest handler after a re-render', () => {
    const first = vi.fn();
    const second = vi.fn();
    const tree = mountReact(<Harness handlers={{ 'palette.open': first }} />);

    tree.render(<Harness handlers={{ 'palette.open': second }} />);

    press('k', { ctrlKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    tree.unmount();
  });
});
