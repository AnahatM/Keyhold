// SPDX-License-Identifier: GPL-3.0-or-later

import { create } from 'zustand';
import { useCredentials } from '../vault/credential-store.js';
import { useSession } from '../vault/session-store.js';
import type { ToolViewId } from './tool-views.js';

/**
 * Which tool view is open, if any.
 *
 * A store rather than a `useState` in `VaultScreen` for one reason: the things that open a
 * tool are not inside the vault screen. The command palette and the shortcut table are
 * mounted at the root (`CommandsProvider`, deliberately above the screen switch), and the
 * native menu will dispatch `tools.health` from the main process. Prop-drilling an opener
 * from `App` down through the shell to reach them would put a callback on every component in
 * between that has no other business knowing tool views exist.
 *
 * It holds an **id, not a component and not a title** — the registry owns those. This module
 * is one nullable value and the three ways to change it.
 *
 * ## It is emptied when the vault locks
 *
 * Same reasoning as `recent-commands.ts`, and the same mechanism. The vault screen unmounts
 * on a lock, but this store does not, so an unlock would drop the user straight back into
 * the health dashboard they had open an hour earlier — announcing what they were last
 * looking at to whoever is now at the keyboard, and skipping past the record list they
 * actually asked for. The reset is a **subscription**, not an effect comparing renders: an
 * effect body that calls `setState` cascades a render on every session tick, and the lint
 * rule forbidding it is right.
 */

interface ToolViewState {
  /** `null` means the three-pane vault is showing. */
  readonly active: ToolViewId | null;
  open: (id: ToolViewId) => void;
  close: () => void;
  /**
   * Opens, or closes when that view is already open.
   *
   * The sidebar row and the menu command both use this, so pressing "Vault health" twice
   * returns you to the vault instead of doing nothing — a nav row that is inert once you
   * are on its page is a dead control.
   */
  toggle: (id: ToolViewId) => void;
}

export const useToolView = create<ToolViewState>((set) => ({
  active: null,
  open: (id) => {
    set({ active: id });
  },
  close: () => {
    set({ active: null });
  },
  toggle: (id) => {
    set((state) => ({ active: state.active === id ? null : id }));
  },
}));

/**
 * Closes any open tool view the instant the vault stops being open.
 *
 * Returns its own unsubscribe so a caller can hand it straight to `useEffect`. The
 * *transition* is checked rather than the state, for the same reason `watchLockForRecents`
 * checks it: resetting on every session tick would be correct and wasteful, and reacting
 * only to `state === 'locked'` would miss a vault being closed back to the welcome screen.
 */
export function watchLockForToolViews(): () => void {
  return useSession.subscribe((state, previous) => {
    const wasOpen = previous.status?.state === 'unlocked';
    const isOpen = state.status?.state === 'unlocked';
    if (wasOpen && !isOpen) useToolView.getState().close();
  });
}

/**
 * Steps the tool view aside the moment there is a record to show.
 *
 * The tool region and the record panes are mutually exclusive, and **the tool is the one
 * that yields** — anything that selects a record or opens the editor is a request to look at
 * that record, whatever it was issued from.
 *
 * Without this, every path into a record that is not the credential list becomes a dead
 * control while a tool is open: Ctrl+N sets `editing`, the palette's row sets `selectedId`,
 * and both then render into panes that are not on screen, so the key appears to do nothing.
 * Handling it here rather than at each call site means it holds for the palette, the
 * shortcut table, the native menu and anything added later, none of which should have to
 * know that tool views exist.
 *
 * Transitions, not states: closing whenever a record merely *is* selected would slam the
 * tool shut the instant it opened, because the vault usually already has one selected
 * behind it.
 */
export function watchSelectionForToolViews(): () => void {
  return useCredentials.subscribe((state, previous) => {
    if (useToolView.getState().active === null) return;
    const selected = state.selectedId !== null && previous.selectedId !== state.selectedId;
    const editorOpened = state.editing && !previous.editing;
    if (selected || editorOpened) useToolView.getState().close();
  });
}
