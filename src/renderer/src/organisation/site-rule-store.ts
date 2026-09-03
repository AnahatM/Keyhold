// SPDX-License-Identifier: GPL-3.0-or-later
import type { GeneratorOptions } from '@shared/model/generator.js';
import type { SiteRule } from '@shared/model/site-rules.js';
import { create } from 'zustand';

/**
 * The vault's per-site generator rules, as the renderer holds them.
 *
 * The same arrangement as `saved-search-store.ts`, and for the same reason: each channel
 * answers with the whole list and this store takes that answer wholesale. Nothing here
 * splices a local copy, so the generator cannot disagree with the vault about which
 * constraint applies — and disagreeing is the failure this feature exists to prevent, since a
 * password generated against a stale rule is one the site will reject.
 *
 * Loaded when a vault opens, and not polled. A rule changes only when the user changes one,
 * which goes through `save` here and comes back as the fresh list.
 */

export interface SiteRuleState {
  readonly rules: readonly SiteRule[];
  readonly busy: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  /** Upsert, keyed by host. Resolves true when it was saved. */
  readonly save: (
    url: string,
    options: Partial<GeneratorOptions>,
    note?: string
  ) => Promise<boolean>;
  readonly remove: (host: string) => Promise<boolean>;
  readonly clearError: () => void;
}

export const useSiteRules = create<SiteRuleState>((set) => {
  const run = async (
    call: () => Promise<{ ok: true; value: readonly SiteRule[] } | { ok: false; message: string }>
  ): Promise<boolean> => {
    set({ busy: true, error: null });
    try {
      const result = await call();
      if (!result.ok) {
        set({ busy: false, error: result.message });
        return false;
      }
      set({ rules: result.value, busy: false, error: null });
      return true;
    } catch {
      set({ busy: false, error: 'That rule could not be saved.' });
      return false;
    }
  };

  return {
    rules: [],
    busy: false,
    error: null,

    refresh: async (): Promise<void> => {
      // The boolean is swallowed deliberately. Failing to read the rules is not worth
      // interrupting anybody about: the generator falls back to its own defaults, which is
      // what it did before rules existed.
      await run(() => window.keyhold.siteRules.read());
    },

    // The contract takes a plain record, because an IPC payload is validated by shape in the
    // main process rather than trusted by type here — a partial `GeneratorOptions` satisfies
    // that without a cast.
    save: (url, options, note) => run(() => window.keyhold.siteRules.set(url, options, note)),

    remove: (host) => run(() => window.keyhold.siteRules.remove(host)),

    clearError: () => {
      set({ error: null });
    },
  };
});
