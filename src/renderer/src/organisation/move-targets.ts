// SPDX-License-Identifier: GPL-3.0-or-later
import { collectDescendantFolderIds } from '@shared/search/filter.js';
import type { Folder } from '@shared/model/vault-document.js';
import { compareFolderSiblings, type FolderNode, type FolderTree } from './folder-tree-model.js';

/**
 * Where a thing can be moved to — the data behind the **keyboard** move path.
 *
 * Drag-and-drop is a mouse gesture with no keyboard equivalent, and a folder tree whose
 * only way to refile a record is to drag it is unusable for anyone navigating by keyboard.
 * WCAG 2.2 makes this explicit twice over: 2.1.1 (everything reachable by keyboard) and
 * 2.5.7 Dragging Movements (any drag action needs a single-pointer alternative). So the
 * "Move to…" menu is not a convenience bolted on later — it is the primary path, and the
 * drag is the shortcut.
 *
 * Both lists are built here, from the same tree the sidebar renders, so the menu can never
 * offer a destination the tree does not show.
 */

export interface MoveTarget {
  /** `null` is the top level for a folder, and "no folder" for a record. */
  readonly folderId: string | null;
  readonly label: string;
  /** Root-first names, for a disambiguating subtitle when two folders share a name. */
  readonly path: readonly string[];
  /** 0 for the top-level entry, then 1-based tree depth. Drives the menu's indentation. */
  readonly depth: number;
  /** Where the thing already is. Shown as such rather than hidden, so the menu reads as a state. */
  readonly current: boolean;
}

function flattenTargets(nodes: readonly FolderNode[], exclude: ReadonlySet<string>): MoveTarget[] {
  const targets: MoveTarget[] = [];
  const walk = (list: readonly FolderNode[]): void => {
    for (const node of list) {
      if (exclude.has(node.folder.id)) continue;
      targets.push({
        folderId: node.folder.id,
        label: node.folder.name,
        path: node.path,
        depth: node.level,
        current: false,
      });
      walk(node.children);
    }
  };
  walk(nodes);
  return targets;
}

function markCurrent(targets: readonly MoveTarget[], currentId: string | null): MoveTarget[] {
  return targets.map((target) => ({ ...target, current: target.folderId === currentId }));
}

/**
 * Where a **folder** may be reparented to.
 *
 * A folder cannot become its own descendant — that is precisely how a cycle gets created,
 * and the cycle guard in `folder-tree-model.ts` exists because it has happened. The excluded
 * set comes from `collectDescendantFolderIds` in `@shared/search/filter.ts`, which already
 * walks parent links with a `seen` guard. Re-deriving "everything under X" here would be a
 * second answer to a question that already has one, and the second one would be the one
 * without the cycle guard.
 *
 * Note it is computed from the raw `folders`, not from the rendered tree: a folder currently
 * stranded in a cycle still has descendants, and offering one of them as a destination would
 * deepen the cycle rather than fix it.
 */
export function folderMoveTargets(
  folders: readonly Folder[],
  tree: FolderTree,
  movingFolderId: string
): readonly MoveTarget[] {
  const blocked = collectDescendantFolderIds(folders, movingFolderId);
  const moving = folders.find((folder) => folder.id === movingFolderId);
  const currentParent = moving?.parentId ?? null;

  return markCurrent(
    [
      { folderId: null, label: 'Top level', path: [], depth: 0, current: false },
      ...flattenTargets(tree.roots, blocked),
    ],
    currentParent
  );
}

/** Where a **record** may be filed. Every folder, plus "no folder". */
export function credentialMoveTargets(
  tree: FolderTree,
  currentFolderId: string | null
): readonly MoveTarget[] {
  return markCurrent(
    [
      { folderId: null, label: 'No folder', path: [], depth: 0, current: false },
      ...flattenTargets(tree.roots, new Set()),
    ],
    currentFolderId
  );
}

/**
 * Whether dropping `draggedId` onto `targetId` is a legal reparent.
 *
 * The same rule the menu enforces, so the drag and the keyboard path cannot disagree about
 * what is allowed. `null` means the top level, which is always legal.
 *
 * A drop onto the folder's existing parent is allowed and is a no-op: refusing it would
 * make a slightly-off drag look broken rather than simply doing nothing.
 */
export function canDropFolder(
  folders: readonly Folder[],
  draggedId: string,
  targetId: string | null
): boolean {
  if (targetId === null) return true;
  if (draggedId === targetId) return false;
  return !collectDescendantFolderIds(folders, draggedId).has(targetId);
}

/**
 * Sibling order for a freshly created folder.
 *
 * Appended rather than inserted, so creating a folder never silently renumbers the ones
 * already there. The main process renormalises orders on write; this is only what the
 * renderer proposes.
 */
export function nextSiblingOrder(folders: readonly Folder[], parentId: string | null): number {
  const siblings = folders.filter((folder) => folder.parentId === parentId);
  if (siblings.length === 0) return 0;
  const last = [...siblings].sort(compareFolderSiblings).at(-1);
  return last === undefined ? 0 : last.order + 1;
}
