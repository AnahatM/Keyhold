// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  createInitialToastState,
  createToast,
  defaultDurationMs,
  earliestExpiry,
  MAX_QUEUED_TOASTS,
  MAX_VISIBLE_TOASTS,
  nextToastId,
  toastReducer,
} from './toast-queue.js';
import type { ToastInput, ToastState } from './toast-types.js';

/**
 * The queue is where toasts actually break, so it is where the tests are.
 *
 * Every case below is a real failure mode rather than a coverage exercise: a flood that
 * runs off the screen, an undo that expires while it is being read, a countdown that keeps
 * running under the pointer, a promoted toast that spends its entire life invisible.
 */

const T0 = 1_000_000;

/** An empty arrow body trips no-empty-function; this says the same thing and is allowed. */
const noop = (): void => undefined;

function push(state: ToastState, input: ToastInput, now: number, seq: number): ToastState {
  return toastReducer(state, {
    type: 'push',
    toast: createToast(input, nextToastId(seq)),
    now,
  });
}

function pushMany(count: number, input: (index: number) => ToastInput, now = T0): ToastState {
  let state = createInitialToastState();
  for (let index = 0; index < count; index += 1) {
    state = push(state, input(index), now, index);
  }
  return state;
}

describe('toast lifetimes', () => {
  it('keeps an undo on screen until it is dealt with', () => {
    // The headline decision: a toast carrying an action does not auto-dismiss, because an
    // undo that expires before it is read is just a delay before data loss.
    expect(
      defaultDurationMs({ title: 'Moved to Trash', action: { label: 'Undo', onAct: noop } })
    ).toBeNull();
  });

  it('keeps a failure on screen until it is dismissed', () => {
    expect(defaultDurationMs({ title: 'Save failed', tone: 'error' })).toBeNull();
  });

  it('expires ordinary toasts', () => {
    expect(defaultDurationMs({ title: 'Copied', tone: 'success' })).toBe(5_000);
    expect(defaultDurationMs({ title: 'Weak password', tone: 'warning' })).toBe(8_000);
  });

  it('lets a caller override the default', () => {
    const toast = createToast({ title: 'Pinned', durationMs: null }, 'a');
    expect(toast.durationMs).toBeNull();
  });

  it('mints ids from a counter, never from randomness', () => {
    expect(nextToastId(0)).toBe('kh-toast-0');
    expect(nextToastId(41)).not.toBe(nextToastId(42));
  });
});

describe('the queue under load', () => {
  it('caps what is on screen and bounds what is waiting', () => {
    // Twenty in a burst — a bulk import reporting per-row failures. Nothing may stack off
    // the bottom of the screen, and nothing may grow without limit behind it.
    const state = pushMany(20, (index) => ({ title: `Row ${index} failed`, tone: 'warning' }));

    expect(state.visible).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(state.queued).toHaveLength(MAX_QUEUED_TOASTS);
    expect(state.visible.length + state.queued.length).toBeLessThan(20);
  });

  it('keeps the newest messages when the queue overflows', () => {
    const state = pushMany(20, (index) => ({ title: `Row ${index}`, tone: 'warning' }));
    const lastQueued = state.queued.at(-1);
    expect(lastQueued?.title).toBe('Row 19');
  });

  it('collapses a repeated message instead of stacking it', () => {
    // Holding the copy shortcut. One toast, counting.
    const state = pushMany(7, () => ({ title: 'Copied', tone: 'success', dedupeKey: 'copy' }));

    expect(state.visible).toHaveLength(1);
    expect(state.queued).toHaveLength(0);
    expect(state.visible[0]?.repeatCount).toBe(7);
  });

  it('restarts the clock when a repeat lands', () => {
    let state = push(createInitialToastState(), { title: 'Copied', dedupeKey: 'copy' }, T0, 0);
    state = push(state, { title: 'Copied', dedupeKey: 'copy' }, T0 + 3_000, 1);
    expect(state.visible[0]?.expiresAt).toBe(T0 + 3_000 + 5_000);
  });

  it('coalesces into a queued toast without promoting it', () => {
    let state = pushMany(MAX_VISIBLE_TOASTS, (index) => ({ title: `Filler ${index}` }));
    state = push(state, { title: 'Copied', dedupeKey: 'copy' }, T0, 90);
    state = push(state, { title: 'Copied', dedupeKey: 'copy' }, T0, 91);

    expect(state.queued).toHaveLength(1);
    expect(state.queued[0]?.repeatCount).toBe(2);
  });
});

describe('an undo is never buried', () => {
  it('takes the slot of an ordinary toast rather than waiting behind it', () => {
    let state = pushMany(MAX_VISIBLE_TOASTS, (index) => ({ title: `Chatter ${index}` }));
    state = push(
      state,
      { title: 'Moved to Trash', action: { label: 'Undo', onAct: noop } },
      T0,
      50
    );

    expect(state.queued).toHaveLength(0);
    expect(state.visible.at(-1)?.title).toBe('Moved to Trash');
    expect(state.visible).toHaveLength(MAX_VISIBLE_TOASTS);
  });

  it('survives a flood that overflows the queue many times over', () => {
    let state = pushMany(MAX_VISIBLE_TOASTS, (index) => ({ title: `Chatter ${index}` }));
    state = push(
      state,
      { title: 'Moved to Trash', dedupeKey: 'undo', action: { label: 'Undo', onAct: noop } },
      T0,
      60
    );

    // Thirty ordinary toasts afterwards — a merge reporting every record it touched.
    for (let index = 0; index < 30; index += 1) {
      state = push(state, { title: `Noise ${index}` }, T0, 100 + index);
    }

    const survived = [...state.visible, ...state.queued].some(
      (toast) => toast.dedupeKey === 'undo'
    );
    expect(survived).toBe(true);
  });
});

describe('promotion', () => {
  it('starts a promoted toast’s clock when it appears, not when it was pushed', () => {
    // Otherwise a toast that waited eight seconds in the queue would appear and vanish in
    // the same frame, having been on screen for none of its life.
    let state = pushMany(MAX_VISIBLE_TOASTS + 1, (index) => ({ title: `Toast ${index}` }));
    const first = state.visible[0];
    expect(first).toBeDefined();

    state = toastReducer(state, { type: 'dismiss', id: first!.id, now: T0 + 4_000 });

    expect(state.queued).toHaveLength(0);
    expect(state.visible.at(-1)?.expiresAt).toBe(T0 + 4_000 + 5_000);
  });
});

describe('reaping', () => {
  it('removes what has expired and keeps what has not', () => {
    let state = push(createInitialToastState(), { title: 'Copied' }, T0, 0);
    state = push(state, { title: 'Save failed', tone: 'error' }, T0, 1);

    state = toastReducer(state, { type: 'reap', now: T0 + 5_001 });

    expect(state.visible).toHaveLength(1);
    expect(state.visible[0]?.title).toBe('Save failed');
  });

  it('reports the earliest deadline so one timer can serve the whole stack', () => {
    let state = push(createInitialToastState(), { title: 'Later', tone: 'warning' }, T0, 0);
    state = push(state, { title: 'Sooner', tone: 'success' }, T0, 1);
    state = push(state, { title: 'Never', tone: 'error' }, T0, 2);

    expect(earliestExpiry(state)).toBe(T0 + 5_000);
  });

  it('has no deadline when nothing expires on its own', () => {
    const state = push(createInitialToastState(), { title: 'Save failed', tone: 'error' }, T0, 0);
    expect(earliestExpiry(state)).toBeNull();
  });
});

describe('pausing', () => {
  it('stops the countdown while the pointer is over the stack', () => {
    let state = push(createInitialToastState(), { title: 'Copied' }, T0, 0);
    state = toastReducer(state, { type: 'pause', reason: 'pointer', now: T0 + 1_000 });

    expect(state.visible[0]?.expiresAt).toBeNull();
    expect(state.visible[0]?.remainingMs).toBe(4_000);
    expect(earliestExpiry(state)).toBeNull();
  });

  it('resumes with the time that was left, not with a fresh duration', () => {
    let state = push(createInitialToastState(), { title: 'Copied' }, T0, 0);
    state = toastReducer(state, { type: 'pause', reason: 'pointer', now: T0 + 1_000 });
    state = toastReducer(state, { type: 'resume', reason: 'pointer', now: T0 + 60_000 });

    expect(state.visible[0]?.expiresAt).toBe(T0 + 60_000 + 4_000);
  });

  it('stays paused while any reason still holds', () => {
    // The pointer leaves a toast whose Undo button still has keyboard focus. Resuming here
    // is the bug: the undo would expire under the hands of the person about to press it.
    let state = push(createInitialToastState(), { title: 'Copied' }, T0, 0);
    state = toastReducer(state, { type: 'pause', reason: 'pointer', now: T0 + 500 });
    state = toastReducer(state, { type: 'pause', reason: 'focus', now: T0 + 600 });
    state = toastReducer(state, { type: 'resume', reason: 'pointer', now: T0 + 700 });

    expect(state.visible[0]?.expiresAt).toBeNull();
    expect(state.pauseReasons).toEqual(['focus']);

    state = toastReducer(state, { type: 'resume', reason: 'focus', now: T0 + 800 });
    expect(state.visible[0]?.expiresAt).toBe(T0 + 800 + 4_500);
  });

  it('does not start a clock on a toast that arrives while paused', () => {
    let state = toastReducer(createInitialToastState(), {
      type: 'pause',
      reason: 'window-hidden',
      now: T0,
    });
    state = push(state, { title: 'Arrived while hidden' }, T0 + 100, 0);

    expect(state.visible[0]?.expiresAt).toBeNull();
    expect(state.visible[0]?.remainingMs).toBe(5_000);

    state = toastReducer(state, { type: 'resume', reason: 'window-hidden', now: T0 + 90_000 });
    expect(state.visible[0]?.expiresAt).toBe(T0 + 90_000 + 5_000);
  });
});

describe('clearing', () => {
  it('empties everything — used on lock, where a toast can name a credential', () => {
    const state = toastReducer(
      pushMany(12, (index) => ({ title: `Toast ${index}` })),
      {
        type: 'clear',
      }
    );
    expect(state).toEqual(createInitialToastState());
  });
});
