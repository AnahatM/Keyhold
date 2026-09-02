// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ToastContext, type ToastApi, type ToastOptions } from './toast-context.js';
import { ToastViewport } from './ToastViewport.js';
import {
  createInitialToastState,
  createToast,
  earliestExpiry,
  nextToastId,
  toastReducer,
} from './toast-queue.js';
import type { ToastInput, ToastPauseReason, ToastTone } from './toast-types.js';
import './chrome.css';

/**
 * Holds the toast queue and drives its single timer.
 *
 * All of the interesting behaviour is in `toast-queue.ts`; this file is the wiring. Two
 * pieces of it are worth reading rather than skimming:
 *
 * **One timer for the whole stack.** The effect below is keyed on the *earliest absolute
 * deadline* in the state, so it schedules exactly one `setTimeout` and reschedules only
 * when that deadline actually moves. There is no interval, no per-toast timer, and nothing
 * that keeps running after unmount — React clears the one timeout for us. The alternative,
 * a tick that decrements a remaining time, is a state write per frame per toast and drifts
 * the moment the renderer is throttled.
 *
 * **The clock never runs during render.** `Date.now()` is read inside event handlers and
 * inside the timeout, never in the render body — an impure read during render is a bug
 * React's compiler is right to reject, and it is why the deadline crosses into state as an
 * absolute number rather than being derived from a duration on the way out.
 */

export interface ToastProviderProps {
  readonly children: ReactNode;
  /**
   * Where the viewport is portalled. Defaults to `document.body`.
   *
   * Portalled rather than rendered in place for two reasons: the app shell's panes are
   * `overflow: auto`, which would clip a corner-anchored stack; and being last in the
   * document puts the toasts last in the tab order, so they never sit between a user and
   * the control they were reaching for.
   */
  readonly container?: HTMLElement;
}

export function ToastProvider({ children, container }: ToastProviderProps): React.JSX.Element {
  const [state, dispatch] = useReducer(toastReducer, undefined, createInitialToastState);

  // A monotonic counter, not randomness — see `nextToastId`. A ref rather than state
  // because bumping it must not itself cause a render.
  const counter = useRef(0);

  /*
   * These are `useCallback` rather than closures inside the `useMemo` below for a reason
   * the linter is right about: a `useMemo` factory runs *during render*, and reading a ref
   * or calling `Date.now()` there is exactly the impurity this codebase has already been
   * bitten by once. In a callback both are correct — nothing here runs until a caller
   * fires an event.
   */
  const show = useCallback((input: ToastInput): string => {
    const id = nextToastId(counter.current);
    counter.current += 1;
    dispatch({ type: 'push', toast: createToast(input, id), now: Date.now() });
    return id;
  }, []);

  const dismiss = useCallback((id: string): void => {
    dispatch({ type: 'dismiss', id, now: Date.now() });
  }, []);

  const clear = useCallback((): void => {
    dispatch({ type: 'clear' });
  }, []);

  const api = useMemo<ToastApi>(() => {
    const withTone =
      (tone: ToastTone) =>
      (title: string, options?: ToastOptions): string =>
        show({ ...options, tone, title });

    return {
      show,
      success: withTone('success'),
      info: withTone('info'),
      warning: withTone('warning'),
      error: withTone('error'),
      dismiss,
      clear,
    };
  }, [show, dismiss, clear]);

  const deadline = earliestExpiry(state);

  useEffect(() => {
    if (deadline === null) return;
    const timer = window.setTimeout(
      () => {
        dispatch({ type: 'reap', now: Date.now() });
      },
      Math.max(0, deadline - Date.now())
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [deadline]);

  useEffect(() => {
    const onVisibilityChange = (): void => {
      const reason: ToastPauseReason = 'window-hidden';
      dispatch({
        type: document.visibilityState === 'hidden' ? 'pause' : 'resume',
        reason,
        now: Date.now(),
      });
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const viewport = (
    <ToastViewport
      toasts={state.visible}
      queuedCount={state.queued.length}
      onDismiss={dismiss}
      onPause={(reason) => {
        dispatch({ type: 'pause', reason, now: Date.now() });
      }}
      onResume={(reason) => {
        dispatch({ type: 'resume', reason, now: Date.now() });
      }}
    />
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(viewport, container ?? document.body)}
    </ToastContext.Provider>
  );
}
