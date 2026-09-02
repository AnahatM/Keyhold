// SPDX-License-Identifier: GPL-3.0-or-later
import { create } from 'zustand';
import type { Folder, Tag } from '@shared/model/vault-document.js';
import {
  browserExpansionStore,
  pruneExpansion,
  readExpansion,
  writeExpansion,
  type ExpansionStore,
} from './expansion-storage.js';
import {
  OrganisationError,
  type FolderDeletionOutcome,
  type FolderDeletionPolicy,
  type OrganisationGateway,
  type OrganisationSnapshot,
} from './gateway.js';
import { createIpcOrganisationGateway } from './ipc-gateway.js';
import { buildFolderTree, type FolderTree } from './folder-tree-model.js';
import {
  DEFAULT_SELECTION,
  toggleTag as toggleTagIn,
  type SidebarSelection,
  type ViewSelection,
} from './selection.js';
import type { TagColourToken } from './tag-colours.js';

/**
 * The sidebar's state: what is selected, what is open, and what the vault says exists.
 *
 * Zustand, like the two stores next door, and holding the same class of data they do —
 * folder and tag metadata, which is already in the safe projection. No secret material
 * reaches this store, and no operation on it could produce any.
 *
 * ## The tree is derived, never stored
 *
 * `folders` is the flat list the vault gave us; `tree` is `buildFolderTree(folders)` and is
 * recomputed whenever that list changes. Storing both and updating them separately is how a
 * tree ends up describing folders that are no longer there — and this particular tree is the
 * one that has to survive cycles, so it must never be a stale copy.
 *
 * ## Every mutation re-reads
 *
 * The gateway returns the whole snapshot and the store adopts it wholesale. Nothing is
 * predicted locally: the main process renormalises sibling order on write, so a locally
 * patched list would render an order the file does not have.
 */

export interface OrganisationState {
  readonly gateway: OrganisationGateway;
  readonly expansionStore: ExpansionStore | null;
  /** Keys the persisted expansion set. Empty until a vault is attached. */
  readonly vaultId: string;

  readonly folders: readonly Folder[];
  readonly tags: readonly Tag[];
  readonly tree: FolderTree;

  readonly selection: SidebarSelection;
  readonly expanded: ReadonlySet<string>;
  /** The row that carries `tabIndex=0` — the roving tabindex of the ARIA tree pattern. */
  readonly focusedFolderId: string | null;

  /** Inline editing state. At most one of these is active at a time. */
  readonly renamingFolderId: string | null;
  readonly draftParentId: string | null | undefined;
  readonly renamingTagId: string | null;

  readonly busy: boolean;
  readonly error: string | null;
  /** Set after a delete, so the UI can say what actually happened to the contents. */
  readonly lastDeletion: FolderDeletionOutcome | null;

  setGateway: (gateway: OrganisationGateway) => void;
  attachVault: (vaultId: string) => Promise<void>;
  refresh: () => Promise<void>;
  clearError: () => void;

  selectView: (view: ViewSelection) => void;
  toggleTagFilter: (tagId: string) => void;
  setTagMatch: (match: 'any' | 'all') => void;
  setIncludeDescendantFolders: (include: boolean) => void;

  setExpanded: (expanded: ReadonlySet<string>) => void;
  toggleExpanded: (folderId: string) => void;
  focusFolder: (folderId: string | null) => void;

  beginCreate: (parentId: string | null) => void;
  beginRename: (folderId: string) => void;
  beginTagRename: (tagId: string | null) => void;
  cancelEditing: () => void;

  createFolder: (name: string, parentId: string | null) => Promise<boolean>;
  renameFolder: (folderId: string, name: string) => Promise<boolean>;
  moveFolder: (folderId: string, parentId: string | null) => Promise<boolean>;
  deleteFolder: (folderId: string, policy: FolderDeletionPolicy) => Promise<boolean>;
  fileCredential: (credentialId: string, folderId: string | null) => Promise<boolean>;

  createTag: (name: string, colour: TagColourToken) => Promise<boolean>;
  renameTag: (tagId: string, name: string) => Promise<boolean>;
  setTagColour: (tagId: string, colour: TagColourToken) => Promise<boolean>;
  deleteTag: (tagId: string) => Promise<boolean>;
}

const EMPTY_TREE = buildFolderTree([]);

function messageFor(error: unknown): string {
  if (error instanceof OrganisationError) return error.message;
  if (error instanceof Error) return error.message;
  return 'That change could not be applied.';
}

export const useOrganisation = create<OrganisationState>((set, get) => {
  /**
   * Adopts a snapshot and everything derived from it.
   *
   * Expansion is pruned here rather than on a timer: a folder that no longer exists must not
   * keep its id in storage forever, and the moment the folder list changes is the only point
   * at which we know which ids are still real.
   */
  const adopt = (snapshot: OrganisationSnapshot): void => {
    const tree = buildFolderTree(snapshot.folders);
    const known = new Set(tree.byId.keys());
    const expanded = pruneExpansion(get().expanded, known);

    const state = get();
    // A folder selection that no longer resolves would filter the list to nothing with no
    // explanation. Falling back to the default view is the honest recovery.
    const selection: SidebarSelection =
      state.selection.view.kind === 'folder' && !known.has(state.selection.view.folderId)
        ? { ...state.selection, view: DEFAULT_SELECTION.view }
        : state.selection;

    set({
      folders: snapshot.folders,
      tags: snapshot.tags,
      tree,
      expanded,
      selection,
      focusedFolderId:
        state.focusedFolderId !== null && known.has(state.focusedFolderId)
          ? state.focusedFolderId
          : null,
    });
    writeExpansion(state.expansionStore, state.vaultId, expanded);
  };

  /** Runs a mutation, adopts its snapshot, and turns any failure into a renderable message. */
  const run = async (
    action: () => Promise<OrganisationSnapshot>,
    onDone?: () => void
  ): Promise<boolean> => {
    set({ busy: true, error: null });
    try {
      adopt(await action());
      onDone?.();
      return true;
    } catch (error) {
      set({ error: messageFor(error) });
      return false;
    } finally {
      set({ busy: false });
    }
  };

  return {
    gateway: createIpcOrganisationGateway(),
    expansionStore: browserExpansionStore(),
    vaultId: '',

    folders: [],
    tags: [],
    tree: EMPTY_TREE,

    selection: DEFAULT_SELECTION,
    expanded: new Set<string>(),
    focusedFolderId: null,

    renamingFolderId: null,
    draftParentId: undefined,
    renamingTagId: null,

    busy: false,
    error: null,
    lastDeletion: null,

    setGateway: (gateway) => {
      set({ gateway });
    },

    /**
     * Points the sidebar at a vault.
     *
     * Locking and switching vaults both come through here. The selection resets: a folder id
     * from the previous vault means nothing in this one, and silently carrying it over would
     * show an empty list with a folder name that is not in the tree.
     */
    attachVault: async (vaultId) => {
      const store = get().expansionStore;
      set({
        vaultId,
        expanded: readExpansion(store, vaultId),
        selection: DEFAULT_SELECTION,
        focusedFolderId: null,
        renamingFolderId: null,
        renamingTagId: null,
        draftParentId: undefined,
        error: null,
      });
      await get().refresh();
    },

    refresh: async () => {
      try {
        adopt(await get().gateway.load());
      } catch (error) {
        // A failed read leaves the previous tree on screen rather than blanking the sidebar;
        // the message says why the folders are stale.
        set({ error: messageFor(error) });
      }
    },

    clearError: () => {
      set({ error: null });
    },

    selectView: (view) => {
      set({ selection: { ...get().selection, view } });
    },

    toggleTagFilter: (tagId) => {
      set({ selection: toggleTagIn(get().selection, tagId) });
    },

    setTagMatch: (tagMatch) => {
      set({ selection: { ...get().selection, tagMatch } });
    },

    setIncludeDescendantFolders: (includeDescendantFolders) => {
      set({ selection: { ...get().selection, includeDescendantFolders } });
    },

    setExpanded: (expanded) => {
      set({ expanded });
      writeExpansion(get().expansionStore, get().vaultId, expanded);
    },

    toggleExpanded: (folderId) => {
      const next = new Set(get().expanded);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      get().setExpanded(next);
    },

    focusFolder: (focusedFolderId) => {
      set({ focusedFolderId });
    },

    beginCreate: (parentId) => {
      set({ draftParentId: parentId, renamingFolderId: null, renamingTagId: null, error: null });
    },

    beginRename: (folderId) => {
      set({
        renamingFolderId: folderId,
        draftParentId: undefined,
        renamingTagId: null,
        error: null,
      });
    },

    beginTagRename: (tagId) => {
      set({ renamingTagId: tagId, renamingFolderId: null, draftParentId: undefined, error: null });
    },

    cancelEditing: () => {
      set({ renamingFolderId: null, renamingTagId: null, draftParentId: undefined, error: null });
    },

    createFolder: async (name, parentId) =>
      run(
        () => get().gateway.createFolder(name, parentId),
        () => {
          // The new folder is inside its parent, so opening the parent is the only way the
          // user sees the thing they just made.
          if (parentId !== null) {
            const next = new Set(get().expanded);
            next.add(parentId);
            get().setExpanded(next);
          }
          set({ draftParentId: undefined });
        }
      ),

    renameFolder: async (folderId, name) =>
      run(
        () => get().gateway.renameFolder(folderId, name),
        () => {
          set({ renamingFolderId: null });
        }
      ),

    moveFolder: async (folderId, parentId) =>
      run(
        () => get().gateway.moveFolder(folderId, parentId),
        () => {
          if (parentId !== null) {
            const next = new Set(get().expanded);
            next.add(parentId);
            get().setExpanded(next);
          }
        }
      ),

    deleteFolder: async (folderId, policy) => {
      set({ busy: true, error: null });
      try {
        const result = await get().gateway.deleteFolder(folderId, policy);
        adopt(result.snapshot);
        set({ lastDeletion: result.outcome });
        return true;
      } catch (error) {
        set({ error: messageFor(error) });
        return false;
      } finally {
        set({ busy: false });
      }
    },

    /**
     * Files one record.
     *
     * No snapshot comes back — folders and tags did not change, the record did. The caller
     * refreshes the session so the list re-reads the projections; doing that here would make
     * this store reach into the session's, which is the coupling the two-store split exists
     * to avoid.
     */
    fileCredential: async (credentialId, folderId) => {
      set({ busy: true, error: null });
      try {
        await get().gateway.fileCredential(credentialId, folderId);
        return true;
      } catch (error) {
        set({ error: messageFor(error) });
        return false;
      } finally {
        set({ busy: false });
      }
    },

    createTag: async (name, colour) => run(() => get().gateway.createTag(name, colour)),

    renameTag: async (tagId, name) =>
      run(
        () => get().gateway.renameTag(tagId, name),
        () => {
          set({ renamingTagId: null });
        }
      ),

    setTagColour: async (tagId, colour) => run(() => get().gateway.setTagColour(tagId, colour)),

    deleteTag: async (tagId) =>
      run(
        () => get().gateway.deleteTag(tagId),
        () => {
          // A filter pointing at a tag that no longer exists silently empties the list.
          const selection = get().selection;
          if (selection.tagIds.includes(tagId)) {
            set({
              selection: { ...selection, tagIds: selection.tagIds.filter((id) => id !== tagId) },
            });
          }
        }
      ),
  };
});
