// SPDX-License-Identifier: GPL-3.0-or-later
import { create } from 'zustand';
import type { CredentialEdit, CredentialInput } from '@shared/ipc/api.js';
import type { CredentialProjection, SecretRef, VersionedField } from '@shared/model/credential.js';
import type { FieldDiffProjection, HistoryPointRef } from '@shared/model/history.js';
import {
  parseQuery,
  scoresById,
  searchCredentials,
  sortCredentials,
  type SortOptions,
} from '@shared/search/index.js';
import { unwrap, useSession } from './session-store.js';

/**
 * Credential list state, selection, and the destructive actions that need undo.
 *
 * Holds projections only — never a secret. A revealed value lives in the component that
 * asked for it, for as long as it is on screen, and is dropped when the component
 * unmounts. Caching reveals here would quietly rebuild the very bulk-secrets store that
 * decision D13 exists to prevent.
 */

/**
 * A destructive action that can be taken back.
 *
 * Every destructive action in Keyhold offers undo, which is only possible because the
 * operations are non-destructive underneath: trashing sets a flag, so undo clears it.
 * Purging is the one exception and is therefore the one action that asks first.
 */
export interface UndoableAction {
  readonly label: string;
  readonly undo: () => Promise<void>;
  readonly at: number;
}

interface CredentialState {
  readonly selectedId: string | null;
  readonly editing: boolean;
  readonly showTrash: boolean;
  readonly query: string;
  /** Ids matched by a deep search of secret material, which the renderer cannot search. */
  readonly deepMatches: readonly string[] | null;
  readonly busy: boolean;
  readonly lastAction: UndoableAction | null;

  select: (credentialId: string | null) => void;
  setEditing: (editing: boolean) => void;
  setShowTrash: (show: boolean) => void;
  setQuery: (query: string) => Promise<void>;

  create: (input: CredentialInput) => Promise<CredentialProjection | null>;
  update: (credentialId: string, edit: CredentialEdit) => Promise<boolean>;
  duplicate: (credentialId: string) => Promise<void>;
  trash: (credentialId: string, title: string) => Promise<void>;
  restore: (credentialId: string) => Promise<void>;
  purge: (credentialId: string) => Promise<void>;

  reveal: (ref: SecretRef) => Promise<string | null>;
  copy: (ref: SecretRef, credentialId: string) => Promise<boolean>;

  /**
   * History. Reads are passthroughs; the two writes go through `persist` like every other
   * mutation, so a restore cannot be the one change that does not reach the file.
   */
  historyDiff: (credentialId: string, versionNumber: number) => Promise<FieldDiffProjection[]>;
  /**
   * What is different between two points in a record's history.
   *
   * Distinct from `historyDiff`, which answers "what did this one edit change". This answers
   * "what is different between then and now", which is the question a timeline cannot.
   */
  historyCompare: (
    credentialId: string,
    from: HistoryPointRef,
    to: HistoryPointRef
  ) => Promise<FieldDiffProjection[]>;
  restoreVersion: (credentialId: string, versionNumber: number) => Promise<boolean>;
  restoreField: (
    credentialId: string,
    versionNumber: number,
    field: VersionedField
  ) => Promise<boolean>;
  clearHistory: (credentialId: string) => Promise<boolean>;
  /**
   * Writes one record's audit trail to a file the user picks.
   *
   * Resolves to the chosen file's name, or `null` if the dialog was dismissed. Never a path —
   * the dialog opens and the file is written in the main process.
   */
  exportHistory: (credentialId: string) => Promise<string | null>;

  clearUndo: () => void;
}

/**
 * Saves after every change.
 *
 * The alternative — an explicit Save button — means a crash or a forgotten click loses
 * work, and in a password manager "I changed my password and it did not save" is the worst
 * possible outcome: the old password is now wrong everywhere and the new one is nowhere.
 * The atomic-write layer makes frequent saves cheap and safe.
 */
async function persist(): Promise<void> {
  unwrap(await window.keyhold.vault.save());
  await useSession.getState().refresh();
}

export const useCredentials = create<CredentialState>((set) => ({
  selectedId: null,
  editing: false,
  showTrash: false,
  query: '',
  deepMatches: null,
  busy: false,
  lastAction: null,

  select: (credentialId) => {
    set({ selectedId: credentialId, editing: false });
  },

  setEditing: (editing) => {
    set({ editing });
  },

  setShowTrash: (showTrash) => {
    set({ showTrash, selectedId: null, editing: false });
  },

  setQuery: async (query) => {
    set({ query });

    // Deep search runs in the main process over notes, security answers and hidden custom
    // values — data the renderer does not have. Only ids come back; the projections already
    // held are enough to render the results.
    if (query.trim().length < 2) {
      set({ deepMatches: null });
      return;
    }
    try {
      set({ deepMatches: unwrap(await window.keyhold.credentials.deepSearch(query)) });
    } catch {
      // A failed deep search should never break the visible filtering, which still works
      // on the projections.
      set({ deepMatches: null });
    }
  },

  create: async (input) => {
    set({ busy: true });
    try {
      const projection = unwrap(await window.keyhold.credentials.create(input));
      await persist();
      set({ selectedId: projection.id, editing: false });
      return projection;
    } finally {
      set({ busy: false });
    }
  },

  update: async (credentialId, edit) => {
    set({ busy: true });
    try {
      const result = unwrap(await window.keyhold.credentials.update(credentialId, edit));
      if (result === null) return false;

      // A no-op edit does not touch the vault, so there is nothing to save. Saving anyway
      // would bump the generation counter and dirty a file the user did not change.
      if (result.changedFields.length > 0) await persist();
      set({ editing: false });
      return true;
    } finally {
      set({ busy: false });
    }
  },

  duplicate: async (credentialId) => {
    set({ busy: true });
    try {
      const copy = unwrap(await window.keyhold.credentials.duplicate(credentialId));
      if (copy === null) return;
      await persist();
      set({ selectedId: copy.id, editing: true });
    } finally {
      set({ busy: false });
    }
  },

  trash: async (credentialId, title) => {
    set({ busy: true });
    try {
      unwrap(await window.keyhold.credentials.trash(credentialId));
      await persist();
      set({
        selectedId: null,
        lastAction: {
          label: `Moved “${title}” to Trash`,
          at: Date.now(),
          undo: async () => {
            unwrap(await window.keyhold.credentials.restore(credentialId));
            await persist();
            set({ lastAction: null, selectedId: credentialId });
          },
        },
      });
    } finally {
      set({ busy: false });
    }
  },

  restore: async (credentialId) => {
    set({ busy: true });
    try {
      unwrap(await window.keyhold.credentials.restore(credentialId));
      await persist();
    } finally {
      set({ busy: false });
    }
  },

  purge: async (credentialId) => {
    // No undo offered, deliberately: this is the one operation that actually loses data, so
    // the confirmation happens before rather than the regret after.
    set({ busy: true });
    try {
      unwrap(await window.keyhold.credentials.purge(credentialId));
      await persist();
      set({ selectedId: null, lastAction: null });
    } finally {
      set({ busy: false });
    }
  },

  reveal: async (ref) => unwrap(await window.keyhold.credentials.revealSecret(ref)),

  copy: async (ref, credentialId) => {
    const state = unwrap(await window.keyhold.session.copySecret(ref));
    if (state === null) return false;

    // Copying counts as using the record — it is what "recently used" and sort-by-frequency
    // are actually measuring.
    await window.keyhold.credentials.markUsed(credentialId);
    await useSession.getState().refresh();
    return true;
  },

  historyDiff: async (credentialId, versionNumber) =>
    unwrap(await window.keyhold.history.diff(credentialId, versionNumber)) ?? [],

  // `?? []` for the same reason as above: `null` means the record is gone, and an empty diff
  // is the honest rendering of "nothing to show" rather than an error about a record that no
  // longer exists.
  historyCompare: async (credentialId, from, to) =>
    unwrap(await window.keyhold.history.compare(credentialId, from, to)) ?? [],

  restoreVersion: async (credentialId, versionNumber) => {
    set({ busy: true });
    try {
      const result = unwrap(
        await window.keyhold.history.restoreVersion(credentialId, versionNumber)
      );
      // A restore to the state the record is already in changes nothing, and must not write
      // a file or claim in the UI that something happened.
      if (result === null || result.changedFields.length === 0) return false;
      await persist();
      return true;
    } finally {
      set({ busy: false });
    }
  },

  restoreField: async (credentialId, versionNumber, field) => {
    set({ busy: true });
    try {
      const result = unwrap(
        await window.keyhold.history.restoreField(credentialId, versionNumber, field)
      );
      if (result === null || result.changedFields.length === 0) return false;
      await persist();
      return true;
    } finally {
      set({ busy: false });
    }
  },

  exportHistory: async (credentialId) =>
    unwrap(await window.keyhold.history.exportHistory(credentialId)),

  clearHistory: async (credentialId) => {
    set({ busy: true });
    try {
      const cleared = unwrap(await window.keyhold.history.clear(credentialId));
      if (cleared) await persist();
      return cleared;
    } finally {
      set({ busy: false });
    }
  },

  clearUndo: () => {
    set({ lastAction: null });
  },
}));

/**
 * Filters, ranks and sorts the visible list.
 *
 * Runs on the safe projection, in the renderer, because that is where the list lives and a
 * round trip per keystroke would make search feel broken. Deep matches from the main
 * process are merged in — matching inside notes, security answers and hidden custom values
 * is the only part the renderer genuinely cannot do, because it does not hold them.
 *
 * **All of the actual work is `@shared/search`.** This function used to reimplement it:
 * `toLowerCase().includes()` over five fields, no diacritic folding, no ranking, a collator
 * built per comparison, and no tiebreak — so "Item 10" sorted before "Item 9" and equal
 * titles could reshuffle between renders. Two implementations of "what does this search
 * find" would have disagreed within a month, and the one the user sees would have been the
 * weaker.
 */
export function visibleCredentials(
  all: readonly CredentialProjection[],
  options: {
    query: string;
    showTrash: boolean;
    deepMatches: readonly string[] | null;
    sort?: SortOptions;
  }
): CredentialProjection[] {
  const parsed = parseQuery(options.query);
  const results = searchCredentials(all, {
    query: parsed,
    trashedOnly: options.showTrash,
    deepMatchIds: options.deepMatches === null ? undefined : new Set(options.deepMatches),
  });

  // Relevance only means something with a query behind it. On an empty box every record
  // would score the same and the list would fall through to the id tiebreak, which reads as
  // random ordering.
  const sort = options.sort ?? {
    key: parsed.isEmpty ? ('title' as const) : ('relevance' as const),
  };

  return [
    ...sortCredentials(
      results.map((result) => result.record),
      { ...sort, scores: scoresById(results) }
    ),
  ];
}
