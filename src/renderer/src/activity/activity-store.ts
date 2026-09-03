// SPDX-License-Identifier: GPL-3.0-or-later
import type { ActivityEntry, ActivitySnapshot } from '@shared/model/activity.js';
import { create } from 'zustand';

/**
 * The session activity log, as the renderer sees it.
 *
 * **Polled, never pushed.** The main process appends to this log on nearly every action —
 * every save, every reveal, every copy — so an event per entry would be a steady stream of
 * IPC to feed a panel that is closed almost all of the time. The panel is something people
 * open to answer a question, not a feed they watch, so it reads when it opens and when they
 * ask again.
 *
 * **A failure is not an error banner.** The log is a diagnostic; a screen that cannot read it
 * says so in place of the list rather than as an alert, because nothing the user was doing
 * has failed.
 */

export interface ActivityState {
  readonly snapshot: ActivitySnapshot | null;
  readonly lastLock: ActivityEntry | null;
  /**
   * When this snapshot was read, which is what "2 minutes ago" is measured against.
   *
   * Stamped here rather than read during render. Partly because a clock call in a render is
   * impure and the lint rule is right about it, and partly because it is the better answer:
   * the times on screen belong to the moment the list was fetched, so they stay consistent
   * with each other across a re-render instead of drifting one row at a time.
   */
  readonly readAt: number;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

export const useActivity = create<ActivityState>((set) => ({
  snapshot: null,
  lastLock: null,
  readAt: 0,
  loading: false,
  error: null,

  refresh: async (): Promise<void> => {
    set({ loading: true });
    try {
      const result = await window.keyhold.activity.read();
      if (!result.ok) {
        set({ loading: false, error: result.message });
        return;
      }
      set({
        snapshot: result.value.snapshot,
        lastLock: result.value.lastLock,
        readAt: Date.now(),
        loading: false,
        error: null,
      });
    } catch {
      // The bridge itself is gone, which in practice means the window is closing. Nothing
      // useful to say and nothing to retry.
      set({ loading: false, error: 'The activity log could not be read.' });
    }
  },
}));
