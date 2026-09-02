// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect } from 'react';
import { useToast } from '../chrome/index.js';
import { useSession } from './session-store.js';

/**
 * Drops every toast when the vault locks.
 *
 * A toast can name a record — "Moved GitHub to Trash", "Copied password for Bank" — and a
 * lock is supposed to mean the vault's contents are no longer on screen. A notification
 * outliving the lock leaves an account name sitting over the unlock screen, which is
 * exactly the kind of thing someone locks their vault to prevent. It also strands an Undo
 * button whose action can no longer run.
 *
 * Implemented as a **store subscription** rather than an effect comparing the previous
 * render's state. Subscribing to an external source and dispatching from its callback is
 * the pattern effects are for; watching a prop and calling `setState` in the effect body
 * cascades a render on every session change, which this component would otherwise do on
 * every unlock, refresh and auto-lock tick.
 *
 * Renders nothing. It is mounted for its subscription, which is why it is a component at
 * all rather than a hook call inside a screen — screens unmount as the session changes,
 * and this must be watching precisely then.
 */
export function ClearToastsOnLock(): null {
  const { clear } = useToast();

  useEffect(
    () =>
      useSession.subscribe((state, previous) => {
        const wasOpen = previous.status?.state === 'unlocked';
        const isOpen = state.status?.state === 'unlocked';
        if (wasOpen && !isOpen) clear();
      }),
    [clear]
  );

  return null;
}
