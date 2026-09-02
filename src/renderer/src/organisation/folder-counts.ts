// SPDX-License-Identifier: GPL-3.0-or-later
import type { CredentialProjection } from '@shared/model/credential.js';
import type { FolderNode, FolderTree } from './folder-tree-model.js';

/**
 * How many records each folder holds, on its own and with everything beneath it.
 *
 * Two numbers rather than one because they answer different questions and a sidebar that
 * shows only one of them lies half the time. "Work" containing nothing directly but three
 * subfolders of twelve records each should not read as empty; and a user dragging a record
 * into "Work" needs to know it will land there, not in a subfolder.
 *
 * ## Trashed records are not counted
 *
 * A trashed record keeps its `folderId` — that is what makes restore put it back where it
 * came from. Counting it would mean deleting a record leaves the folder's number unchanged,
 * which reads as the delete having failed. Trash has its own smart view with its own count.
 *
 * ## Why this aggregates over the tree instead of calling the shared descendant walk
 *
 * `collectDescendantFolderIds` answers "what is under X" for one X. Calling it per folder is
 * O(n²) on the vault's folder count, and the sidebar recomputes on every record change. The
 * built tree is already acyclic (see `folder-tree-model.ts`), so one bottom-up pass gives
 * every folder's total in O(n). `folder-counts.test.ts` asserts this agrees with the shared
 * walk for every folder in a well-formed tree, which is what stops the two drifting apart.
 */

export interface FolderCounts {
  /** Records filed directly in this folder. */
  readonly own: ReadonlyMap<string, number>;
  /** This folder plus every folder beneath it. */
  readonly total: ReadonlyMap<string, number>;
  /** Records filed in no folder at all. */
  readonly unfiled: number;
  /**
   * Records naming a folder that is not in the tree.
   *
   * A real post-merge state, and one worth surfacing: those records are invisible in every
   * folder view, so a silent zero here is how someone concludes their records vanished.
   */
  readonly unresolved: number;
  readonly unresolvedFolderIds: readonly string[];
}

export function countRecordsByFolder(
  records: readonly CredentialProjection[],
  tree: FolderTree
): FolderCounts {
  const own = new Map<string, number>();
  for (const id of tree.byId.keys()) own.set(id, 0);

  let unfiled = 0;
  const unresolved = new Set<string>();
  let unresolvedCount = 0;

  for (const record of records) {
    if (record.trashedAt !== null) continue;
    const folderId = record.folderId;
    if (folderId === null) {
      unfiled += 1;
      continue;
    }
    const current = own.get(folderId);
    if (current === undefined) {
      unresolved.add(folderId);
      unresolvedCount += 1;
      continue;
    }
    own.set(folderId, current + 1);
  }

  const total = new Map<string, number>();
  const accumulate = (node: FolderNode): number => {
    let sum = own.get(node.folder.id) ?? 0;
    for (const child of node.children) sum += accumulate(child);
    total.set(node.folder.id, sum);
    return sum;
  };
  for (const root of tree.roots) accumulate(root);

  return {
    own,
    total,
    unfiled,
    unresolved: unresolvedCount,
    unresolvedFolderIds: [...unresolved].sort(),
  };
}

/**
 * What deleting a folder would move, so the confirm dialog can state it rather than guess.
 *
 * Both numbers are what the user is about to be responsible for: records directly inside,
 * and the subfolders that have to go somewhere. Descendant records are reported too because
 * "delete Work" with 40 records under it is a very different decision from one with none.
 */
export interface FolderDeletionImpact {
  readonly directRecords: number;
  readonly descendantRecords: number;
  readonly directSubfolders: number;
  readonly descendantSubfolders: number;
  /** The folder the contents move up into, or `null` for the top level. */
  readonly parentId: string | null;
  readonly parentName: string | null;
}

export function folderDeletionImpact(
  tree: FolderTree,
  counts: FolderCounts,
  folderId: string
): FolderDeletionImpact | null {
  const node = tree.byId.get(folderId);
  if (node === undefined) return null;

  const parentId = node.folder.parentId;
  const parent = parentId === null ? undefined : tree.byId.get(parentId);

  let descendantSubfolders = 0;
  const countBelow = (nodes: readonly FolderNode[]): void => {
    for (const child of nodes) {
      descendantSubfolders += 1;
      countBelow(child.children);
    }
  };
  countBelow(node.children);

  const own = counts.own.get(folderId) ?? 0;
  const total = counts.total.get(folderId) ?? own;

  return {
    directRecords: own,
    descendantRecords: total - own,
    directSubfolders: node.children.length,
    descendantSubfolders,
    // A folder promoted out of a cycle or off a missing parent has no usable parent to
    // move things into, so its contents go to the top level rather than to a folder that
    // is not there.
    parentId: parent === undefined ? null : parentId,
    parentName: parent === undefined ? null : parent.folder.name,
  };
}
