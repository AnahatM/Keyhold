// SPDX-License-Identifier: GPL-3.0-or-later

import { createContext, useContext } from 'react';
import type { ToastInput, ToastTone } from './toast-types.js';

/**
 * The context and the hook, kept out of `ToastProvider.tsx`.
 *
 * Not tidiness: a `.tsx` file that exports both a component and a hook loses fast refresh
 * for that component (`react-refresh/only-export-components`), which in practice means
 * every toast in the app is wiped on every save while working on the provider.
 */

/** Everything a caller may pass except the parts a convenience method already decides. */
export type ToastOptions = Omit<ToastInput, 'tone' | 'title'>;

export interface ToastApi {
  /**
   * Show a toast. Returns the id of the live toast — which is the id passed in, or, when
   * this message coalesced into an existing one, the id that entry has just adopted.
   * Either way it is the id `dismiss` wants.
   */
  readonly show: (input: ToastInput) => string;
  readonly success: (title: string, options?: ToastOptions) => string;
  readonly info: (title: string, options?: ToastOptions) => string;
  readonly warning: (title: string, options?: ToastOptions) => string;
  /** Stays until dismissed — see the lifetime rules in `toast-queue.ts`. */
  readonly error: (title: string, options?: ToastOptions) => string;
  readonly dismiss: (id: string) => void;
  /** Removes everything, visible and queued. Used on lock: a toast can name a credential. */
  readonly clear: () => void;
}

export const ToastContext = createContext<ToastApi | null>(null);

/**
 * The toast API.
 *
 * Throws when there is no provider above it rather than returning a no-op. A silently
 * swallowed "Save failed" is a worse outcome than a crash in development, and this is the
 * kind of mistake that only ever shows up in the one code path nobody clicked.
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) {
    throw new Error('useToast() requires a <ToastProvider> above it in the tree.');
  }
  return api;
}

/**
 * The politeness a tone is announced with.
 *
 * Errors are assertive: they interrupt whatever the screen reader is saying, because a
 * failed save is the one thing the user must not walk away without hearing. **Everything
 * else is polite** and waits its turn.
 *
 * Getting this backwards is the classic toast bug — an assertive "Copied" cuts off the
 * announcement of the error that landed a moment earlier, so the user hears the trivia and
 * misses the failure. Warnings stay polite for the same reason: they are frequent in this
 * app (weak password, expiring soon) and an interruption per warning would make the app
 * unusable with a screen reader.
 */
export function politenessFor(tone: ToastTone): 'assertive' | 'polite' {
  return tone === 'error' ? 'assertive' : 'polite';
}
