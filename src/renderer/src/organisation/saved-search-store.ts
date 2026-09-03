// SPDX-License-Identifier: GPL-3.0-or-later
import type { SavedSearch } from '@shared/model/saved-search.js';
import { create } from 'zustand';

/**
 * The vault's saved searches, as the renderer holds them.
 *
 * ## Every mutation replaces the whole list
 *
 * Each channel answers with the full list rather than the entry it touched, and this store
 * takes that answer wholesale. Nothing here splices, filters or reorders a local copy. That
 * is not laziness about efficiency — the list is capped at a hundred short strings — it is
 * the only arrangement in which the sidebar cannot disagree with the vault about what exists.
 * A store that patched its own copy would drift the first time two windows, an undo, or a
 * merge changed the list underneath it, and the symptom would be a shortcut that is visibly
 * there and does nothing.
 *
 * ## The error is held, not thrown
 *
 * These operations are invoked from a sidebar row and a small dialog, and the failures are
 * ordinary refusals — a duplicate name, an empty query, the cap. They belong beside the
 * control that caused them, so the caller reads `error` rather than catching. `null` after a
 * successful call, so a stale refusal cannot outlive the thing it refused.
 */

export interface SavedSearchState {
  readonly searches: readonly SavedSearch[];
  readonly busy: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  /** Resolves true when it was saved. The dialog closes on true and stays open on false. */
  readonly create: (name: string, query: string) => Promise<boolean>;
  readonly rename: (searchId: string, name: string) => Promise<boolean>;
  readonly remove: (searchId: string) => Promise<boolean>;
  readonly clearError: () => void;
}

export const useSavedSearches = create<SavedSearchState>((set) => {
  /**
   * Runs one call and folds its answer in.
   *
   * One place where a result is unwrapped, an error is stored and `busy` is cleared, because
   * four call sites each doing it themselves is four chances to leave `busy` true on the
   * failure path — which locks the control that would let the user try again.
   */
  const run = async (
    call: () => Promise<
      { ok: true; value: readonly SavedSearch[] } | { ok: false; message: string }
    >
  ): Promise<boolean> => {
    set({ busy: true, error: null });
    try {
      const result = await call();
      if (!result.ok) {
        set({ busy: false, error: result.message });
        return false;
      }
      set({ searches: result.value, busy: false, error: null });
      return true;
    } catch {
      // The bridge itself is unreachable, which in practice means the window is closing.
      set({ busy: false, error: 'That change could not be saved.' });
      return false;
    }
  };

  return {
    searches: [],
    busy: false,
    error: null,

    refresh: async (): Promise<void> => {
      // Deliberately swallows the boolean. A refresh failing is not something to interrupt
      // the user about: the sidebar simply shows the searches it already had, or none.
      await run(() => window.keyhold.searches.read());
    },

    create: (name, query) => run(() => window.keyhold.searches.create(name, query)),
    rename: (searchId, name) => run(() => window.keyhold.searches.update(searchId, { name })),
    remove: (searchId) => run(() => window.keyhold.searches.remove(searchId)),

    clearError: () => {
      set({ error: null });
    },
  };
});
