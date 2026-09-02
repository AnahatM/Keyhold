// SPDX-License-Identifier: GPL-3.0-or-later

import { create } from 'zustand';
import { useSession } from '../vault/session-store.js';

/**
 * What you reached for last, so the palette opens on it.
 *
 * ## In memory, and gone on lock. Both are security requirements, not preferences.
 *
 * A persisted "recently used" list is a **plaintext record of someone's accounts** sitting
 * outside the encrypted file. Nothing about the vault's crypto helps if `localStorage`
 * holds `credential:…` keys for the bank, the employer and the dating site — an attacker
 * with the disk gets the shape of a life without ever touching the KEEP. So this store
 * never writes anywhere: no `localStorage`, no disk, no IPC. It is a variable, and a
 * variable dies with the window.
 *
 * Locking has to clear it for the same reason `ClearToastsOnLock` exists: a lock means the
 * vault's contents are no longer on screen, and a palette that still lists "Go to Chase
 * Bank" over an unlock screen has broken that promise. The clear is driven by a
 * **subscription** to the session store rather than an effect comparing render to render —
 * an effect body that calls `setState` cascades a render on every session tick, and the
 * lint rule forbidding it is right to.
 *
 * ## Keys, not commands
 *
 * Entries are the opaque `command:…` / `credential:…` keys from `palette-search.ts`, never
 * the objects. A remembered command whose handler has since unmounted, or a record that has
 * been trashed, then resolves to nothing and silently drops out of the list — instead of
 * being a row that throws when someone presses Enter on it.
 */

/**
 * How many are kept.
 *
 * Small on purpose. Recents are the top of an empty palette, above the full command list,
 * and a dozen of them would push every command below the fold and make the palette worse at
 * the thing it is named after.
 */
export const MAX_RECENTS = 6;

interface RecentState {
  readonly keys: readonly string[];
  remember: (key: string) => void;
  clear: () => void;
}

/**
 * Moves a key to the front, keeping the list unique and capped.
 *
 * Pure and exported so the ordering rules — most recent first, no duplicates, oldest
 * evicted — are asserted directly rather than through the store.
 */
export function pushRecent(
  keys: readonly string[],
  key: string,
  limit: number = MAX_RECENTS
): readonly string[] {
  if (limit <= 0) return [];
  return [key, ...keys.filter((existing) => existing !== key)].slice(0, limit);
}

export const useRecentCommands = create<RecentState>((set) => ({
  keys: [],
  remember: (key) => {
    set((state) => ({ keys: pushRecent(state.keys, key) }));
  },
  clear: () => {
    set({ keys: [] });
  },
}));

/**
 * Drops the recents the instant the vault stops being open.
 *
 * Returns its own unsubscribe, so a caller can hand it straight to `useEffect`. The
 * transition is checked rather than the state — clearing on every session tick would be
 * correct and wasteful, and clearing only on `state === 'locked'` would miss a vault being
 * closed back to the welcome screen.
 */
export function watchLockForRecents(): () => void {
  return useSession.subscribe((state, previous) => {
    const wasOpen = previous.status?.state === 'unlocked';
    const isOpen = state.status?.state === 'unlocked';
    if (wasOpen && !isOpen) useRecentCommands.getState().clear();
  });
}
