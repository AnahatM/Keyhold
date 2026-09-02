// SPDX-License-Identifier: GPL-3.0-or-later

import { act, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from './ToastProvider.js';
import { useToast, type ToastApi } from './toast-context.js';
import { mountReact, type MountedTree } from './test-dom.js';

/**
 * The wiring the reducer tests cannot reach: which DOM event maps to which pause reason,
 * and whether the single timer really is gone after unmount.
 *
 * The timing rules themselves live in `toast-queue.test.ts`, against pure functions.
 */

let api: ToastApi | null = null;

/*
 * The api is published from an effect, not from the render body. Assigning to a variable
 * outside the component during render is a side effect, and React's own lint rule for it
 * is one this codebase honours rather than silences — even in a test.
 */
function Probe(): null {
  const toast = useToast();
  useEffect(() => {
    api = toast;
  }, [toast]);
  return null;
}

let tree: MountedTree | null = null;
let host: HTMLElement | null = null;

function mountProvider(): void {
  host = document.createElement('div');
  document.body.append(host);
  tree = mountReact(
    <ToastProvider container={host}>
      <Probe />
    </ToastProvider>
  );
}

function toasts(): readonly Element[] {
  return Array.from(host?.querySelectorAll('.kh-toast') ?? []);
}

function viewport(): Element {
  const element = host?.querySelector('.kh-toasts');
  if (element === null || element === undefined) throw new Error('no viewport');
  return element;
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mountProvider();
});

afterEach(() => {
  tree?.unmount();
  tree = null;
  api = null;
  host = null;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('ToastProvider', () => {
  it('shows a toast and takes it away when its time is up', () => {
    act(() => {
      api?.success('Copied');
    });
    expect(toasts()).toHaveLength(1);

    advance(5_100);
    expect(toasts()).toHaveLength(0);
  });

  it('keeps an error until it is dismissed', () => {
    act(() => {
      api?.error('Could not save');
    });
    advance(120_000);
    expect(toasts()).toHaveLength(1);
  });

  it('sends errors to the assertive region and everything else to the polite one', () => {
    // Backwards, a screen-reader user is interrupted by "Copied" and never hears the
    // failure that arrived a moment earlier.
    act(() => {
      api?.error('Could not save');
      api?.success('Copied');
    });

    const assertive = host?.querySelector('[aria-live="assertive"]');
    const polite = host?.querySelector('[aria-live="polite"]');

    expect(assertive?.querySelectorAll('.kh-toast')).toHaveLength(1);
    expect(polite?.querySelectorAll('.kh-toast')).toHaveLength(1);
    expect(assertive?.textContent).toContain('Could not save');
  });

  it('stops the countdown while the pointer is over the stack', () => {
    act(() => {
      api?.success('Copied');
    });

    act(() => {
      viewport().dispatchEvent(new Event('pointerover', { bubbles: true }));
    });
    advance(60_000);
    expect(toasts()).toHaveLength(1);

    act(() => {
      viewport().dispatchEvent(new Event('pointerout', { bubbles: true }));
    });
    advance(4_000);
    expect(toasts()).toHaveLength(1);
    advance(1_500);
    expect(toasts()).toHaveLength(0);
  });

  it('stops the countdown while focus is inside the stack', () => {
    // WCAG 2.2 SC 2.2.1, and the reason an Undo does not vanish under the hands of the
    // keyboard user who has just tabbed to it.
    act(() => {
      api?.show({ title: 'Moved to Trash', durationMs: 5_000 });
    });

    const dismiss = host?.querySelector<HTMLButtonElement>('.kh-toast__dismiss');
    expect(dismiss).not.toBeNull();

    act(() => {
      dismiss?.focus();
    });
    advance(60_000);
    expect(toasts()).toHaveLength(1);
  });

  it('caps the stack and says how many are waiting', () => {
    act(() => {
      for (let index = 0; index < 20; index += 1) api?.warning(`Row ${index} failed`);
    });

    expect(toasts()).toHaveLength(3);
    expect(host?.querySelector('.kh-toasts__queued')?.textContent).toBe('+8 more');
  });

  it('leaves no timer running after unmount', () => {
    act(() => {
      api?.success('Copied');
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    tree?.unmount();
    tree = null;

    expect(vi.getTimerCount()).toBe(0);
  });
});
