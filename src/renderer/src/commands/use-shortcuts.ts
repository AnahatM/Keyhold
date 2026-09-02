// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef } from 'react';
import type { Platform } from '@shared/ipc/api.js';
import { matchesEvent } from './key-combo.js';
import { canFire, type ShortcutEnvironment } from './shortcut-gate.js';
import { SHORTCUTS, type ShortcutDefinition, type ShortcutId } from './shortcut-registry.js';
import { isTypingInto } from './text-entry.js';

/**
 * The one global `keydown` listener.
 *
 * It reads `SHORTCUTS` — the table — and nothing else. There is no second place in the app
 * where a key is compared against a string, which is the entire point of the registry.
 *
 * ## The listener is removed on unmount
 *
 * Stated because getting it wrong is invisible: a `keydown` on `window` that outlives its
 * component keeps firing forever, against a closure holding a store and a handler from a
 * tree that no longer exists. It survives every navigation, accumulates one more copy per
 * mount, and the symptom is a shortcut that runs twice, then three times.
 *
 * ## Why the environment lives in a ref
 *
 * The listener is registered once, not once per render. Handlers here are inline closures
 * over component state and change identity every render, so depending on them would add and
 * remove a `window` listener on every keystroke typed into the search box. The current
 * values are pushed into a ref instead, and the listener reads the ref — the standard shape
 * for "a subscription that must not be torn down, reading state that changes".
 *
 * ## Bubble phase, deliberately
 *
 * Not capture. An overlay that has already handled a key stops the event — `Modal.tsx` does
 * exactly this for Escape, so that Escape closes the topmost dialog and nothing else. A
 * capture-phase listener on `window` would see the key *first* and run the app-level
 * shortcut before the dialog got the chance to say it had handled it.
 */

/**
 * Identical to `CommandHandler` on purpose, and stated separately on purpose.
 *
 * The same signature, because one action is bound to both a palette row and a key and the
 * two must be the same function. Declared here rather than imported, because the shortcut
 * system does not otherwise depend on the palette's registry and should not start: the key
 * listener works in an app with no palette in it. If the shapes ever have to differ, the
 * mismatch belongs at the one place that feeds both — `CommandsProvider` — and not inside
 * `use-shortcuts`, which must never be handed something it would have to float.
 */
export type ShortcutHandler = () => void;

/** `| undefined` spelled out for `exactOptionalPropertyTypes` — see `CommandHandlers`. */
export type ShortcutHandlers = Readonly<Partial<Record<ShortcutId, ShortcutHandler | undefined>>>;

export interface UseShortcutsOptions extends Omit<ShortcutEnvironment, 'typing'> {
  /**
   * `null` while the main process has not answered yet.
   *
   * With no platform there is no way to know whether `mod` means Command or Control, so for
   * the handful of milliseconds before the answer arrives **both** are accepted. The
   * alternative — guessing `win32` — would leave Command+K dead on a Mac during startup,
   * and a shortcut that does not work the first time is a shortcut the user stops trying.
   */
  readonly platform: Platform | null;
  /** Off entirely. Reserved for the setting that turns shortcuts off (hard rule 7). */
  readonly enabled?: boolean;
}

/** Matches against both accelerators while the platform is still unknown. */
function eventMatches(
  shortcut: ShortcutDefinition,
  event: KeyboardEvent,
  platform: Platform | null
): boolean {
  if (platform !== null) return matchesEvent(shortcut.combo, event, platform);
  return (
    matchesEvent(shortcut.combo, event, 'darwin') || matchesEvent(shortcut.combo, event, 'win32')
  );
}

interface Latest {
  readonly handlers: ShortcutHandlers;
  readonly options: UseShortcutsOptions;
}

export function useShortcuts(handlers: ShortcutHandlers, options: UseShortcutsOptions): void {
  const latest = useRef<Latest>({ handlers, options });

  // Written in an effect rather than during render: a render must not have side effects,
  // and React may render a component without committing it.
  useEffect(() => {
    latest.current = { handlers, options };
  });

  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      // A key that is only a modifier is not a shortcut, and `Dead` arrives mid
      // compose-sequence on international layouts — neither should be matched.
      if (event.repeat) return;

      const { handlers: current, options: env } = latest.current;

      const environment: ShortcutEnvironment = {
        locked: env.locked,
        overlayOpen: env.overlayOpen,
        typing: isTypingInto(event.target, document.activeElement),
        scopes: env.scopes,
      };

      for (const shortcut of SHORTCUTS) {
        const handler = current[shortcut.id];
        // No handler means the feature is not mounted. Checked before the gate so an
        // unbound shortcut cannot swallow a keystroke the browser would have used.
        if (handler === undefined) continue;
        if (!eventMatches(shortcut, event, env.platform)) continue;
        if (!canFire(shortcut, environment)) continue;

        // Only once a shortcut has actually claimed the key. Ctrl+S must not be allowed to
        // reach the host's own save, and Ctrl+F must not open a find bar over the app — but
        // a combination nothing is listening for is left entirely alone.
        event.preventDefault();
        event.stopPropagation();
        handler();
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled]);
}
