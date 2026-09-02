// SPDX-License-Identifier: GPL-3.0-or-later
import type { Folder } from '@shared/model/vault-document.js';

/**
 * Turning a flat `Folder[]` into something a `role="tree"` can render — **without ever
 * trusting it**.
 *
 * ## A folder list is not a tree until this file has looked at it
 *
 * `folders` arrives from a decrypted file that may have been merged from two devices,
 * imported from another manager, restored from a partial backup, or hand-edited. Three
 * things that "cannot happen" are all real states:
 *
 *   - a folder whose `parentId` names no folder at all (a partial restore),
 *   - a cycle, A → B → A (a merge that reparented both sides),
 *   - two folders sharing an id (a bad import).
 *
 * A renderer that walks parent links without a `seen` set spins forever on the second one,
 * with the UI thread inside the loop, and the window simply stops responding. That is the
 * worst possible failure: the user's data is fine, and the app looks like it ate it.
 *
 * So: **every broken folder is still rendered**, promoted to the top level and flagged, and
 * every problem is reported in `problems` for the UI to surface. Nothing is repaired — this
 * module has no business rewriting a vault, and a silent repair would hide a merge bug that
 * the user needs to know about. Render what you can, say what is wrong, never hang.
 *
 * ## Relationship to the two walks that already exist
 *
 * `collectDescendantFolderIds` (`@shared/search/filter.ts`) answers "which ids are at or
 * under X" as a set, and is what the folder filter and the move-target list use — this
 * module does not re-answer that question. What is built here is a different thing: an
 * **ordered layout** with levels, sibling order, paths and a visible/collapsed projection,
 * which a set cannot express. `folder-tree-model.test.ts` asserts the two agree on every
 * well-formed tree, so they cannot drift apart.
 *
 * `compareSiblings` in `src/main/organisation/folder-tree.ts` is the same two-line ordering
 * rule as `compareFolderSiblings` below. That duplication is deliberate and unavoidable
 * today: the renderer is architecturally forbidden from importing `@main/*` (it is where
 * the keys live — see the ESLint `no-restricted-imports` rule), and the ordering rule lives
 * in a main-process file. The right fix is to move the rule into a renderer-safe shared
 * module; it is recorded rather than made, because neither file is this module's to edit.
 */

/**
 * How deep the renderer will descend before it stops.
 *
 * Not a product limit — a stack guard. Recursion over a chain thousands deep would throw a
 * RangeError mid-render and blank the sidebar; refusing to descend past a depth no human
 * folder tree reaches keeps the rest of the tree on screen and turns the situation into a
 * reported problem instead of a crash.
 */
export const MAX_RENDER_DEPTH = 64;

/** Why a node sits at the top level. Only `'root'` is a healthy answer for a root. */
export type FolderAttachment = 'root' | 'child' | 'missing-parent' | 'cycle';

export interface FolderNode {
  readonly folder: Folder;
  /** 1-based, so it can be handed straight to `aria-level`. */
  readonly level: number;
  /** Names root-first, including this folder's own. Used for move-menu labels. */
  readonly path: readonly string[];
  readonly children: readonly FolderNode[];
  readonly attachment: FolderAttachment;
}

export type FolderProblemKind = 'missing-parent' | 'cycle' | 'duplicate-id' | 'depth-limit';

export interface FolderProblem {
  readonly kind: FolderProblemKind;
  readonly folderId: string;
  readonly folderName: string;
  /** One sentence, safe to render. Never contains anything but folder names. */
  readonly detail: string;
}

export interface FolderTree {
  readonly roots: readonly FolderNode[];
  readonly byId: ReadonlyMap<string, FolderNode>;
  readonly problems: readonly FolderProblem[];
  /** The folders that made it into the tree — duplicates by id dropped, first wins. */
  readonly folders: readonly Folder[];
}

/**
 * Total order on siblings: `order`, then id.
 *
 * The id tiebreak is what makes it total. Two siblings sharing an `order` is a normal
 * post-merge state, and without the tiebreak their rendered order would depend on array
 * position — which changes on every save, so a folder would appear to jump around on its
 * own between two renders that show the same data.
 */
export function compareFolderSiblings(a: Folder, b: Folder): number {
  if (a.order !== b.order) return a.order - b.order;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function describeCycle(folder: Folder): string {
  return `“${folder.name}” is inside itself — its parent chain loops. Shown at the top level so its records stay reachable.`;
}

/**
 * Builds the render tree, cycle-safe and orphan-safe.
 *
 * The `visited` set is shared across the whole build, not per branch. That is what makes a
 * cycle terminate: the second time the walk reaches a folder it stops, so A → B → A yields
 * A with child B and nothing further, instead of an infinite descent.
 */
export function buildFolderTree(folders: readonly Folder[]): FolderTree {
  const problems: FolderProblem[] = [];

  // First occurrence wins, so the tree is deterministic when a bad import produced two
  // folders with the same id. Both are reported; only one is rendered, because rendering
  // both would give the tree two nodes that every id-keyed operation cannot tell apart.
  const byIdFolder = new Map<string, Folder>();
  const accepted: Folder[] = [];
  for (const folder of folders) {
    const existing = byIdFolder.get(folder.id);
    if (existing !== undefined) {
      problems.push({
        kind: 'duplicate-id',
        folderId: folder.id,
        folderName: folder.name,
        detail: `Two folders share the id ${folder.id} (“${existing.name}” and “${folder.name}”). Only the first is shown.`,
      });
      continue;
    }
    byIdFolder.set(folder.id, folder);
    accepted.push(folder);
  }

  const childrenByParent = new Map<string, Folder[]>();
  for (const folder of accepted) {
    if (folder.parentId === null) continue;
    const siblings = childrenByParent.get(folder.parentId);
    if (siblings === undefined) childrenByParent.set(folder.parentId, [folder]);
    else siblings.push(folder);
  }

  const visited = new Set<string>();
  const byId = new Map<string, FolderNode>();

  const build = (
    folder: Folder,
    level: number,
    parentPath: readonly string[],
    attachment: FolderAttachment
  ): FolderNode => {
    visited.add(folder.id);
    const path = [...parentPath, folder.name];

    let children: readonly FolderNode[] = [];
    if (level >= MAX_RENDER_DEPTH) {
      const belowCount = childrenByParent.get(folder.id)?.length ?? 0;
      if (belowCount > 0) {
        problems.push({
          kind: 'depth-limit',
          folderId: folder.id,
          folderName: folder.name,
          detail: `“${folder.name}” is nested more than ${MAX_RENDER_DEPTH} levels deep. Its contents are not shown here.`,
        });
      }
    } else {
      children = [...(childrenByParent.get(folder.id) ?? [])]
        // The cycle guard. A child already on screen somewhere is not descended into again.
        .filter((child) => !visited.has(child.id))
        .sort(compareFolderSiblings)
        .map((child) => build(child, level + 1, path, 'child'));
    }

    const node: FolderNode = { folder, level, path, children, attachment };
    byId.set(folder.id, node);
    return node;
  };

  const roots: FolderNode[] = [];

  // 1. The healthy roots.
  for (const folder of accepted.filter((f) => f.parentId === null).sort(compareFolderSiblings)) {
    roots.push(build(folder, 1, [], 'root'));
  }

  // 2. Orphans — a `parentId` naming nothing. Promoted rather than dropped: the folder is
  //    real and so are the records inside it, and hiding it would look like data loss.
  const orphans = accepted
    .filter((f) => f.parentId !== null && !byIdFolder.has(f.parentId) && !visited.has(f.id))
    .sort(compareFolderSiblings);
  for (const folder of orphans) {
    problems.push({
      kind: 'missing-parent',
      folderId: folder.id,
      folderName: folder.name,
      detail: `“${folder.name}” points at a folder that no longer exists. Shown at the top level.`,
    });
    roots.push(build(folder, 1, [], 'missing-parent'));
  }

  // 3. Whatever is left is unreachable from any root with an existing parent — i.e. it is
  //    in a cycle. Each cycle gets exactly one entry point, and the shared `visited` set
  //    stops the walk from going round.
  const stranded = accepted.filter((f) => !visited.has(f.id)).sort(compareFolderSiblings);
  for (const folder of stranded) {
    if (visited.has(folder.id)) continue;
    problems.push({
      kind: 'cycle',
      folderId: folder.id,
      folderName: folder.name,
      detail: describeCycle(folder),
    });
    roots.push(build(folder, 1, [], 'cycle'));
  }

  return { roots, byId, problems, folders: accepted };
}

// ── The visible projection ───────────────────────────────────────────────────

export interface TreeRow {
  readonly node: FolderNode;
  readonly id: string;
  /** 1-based; goes straight to `aria-level`. */
  readonly level: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  /** `null` for a row at the top level. */
  readonly parentId: string | null;
  /** 1-based, for `aria-posinset`. */
  readonly posInSet: number;
  /** For `aria-setsize`. */
  readonly setSize: number;
}

/**
 * The rows a collapsed-and-expanded tree actually shows, in order.
 *
 * Flattening up front is what makes keyboard navigation a pure function over an array
 * rather than a walk through the DOM: Down is "the next row", Left is "my parent's row",
 * and neither has to know anything about React. `tree-keyboard.ts` operates on exactly
 * this list.
 */
export function flattenVisible(
  tree: FolderTree,
  expanded: ReadonlySet<string>
): readonly TreeRow[] {
  const rows: TreeRow[] = [];

  const walk = (nodes: readonly FolderNode[], parentId: string | null): void => {
    nodes.forEach((node, index) => {
      const hasChildren = node.children.length > 0;
      const isExpanded = hasChildren && expanded.has(node.folder.id);
      rows.push({
        node,
        id: node.folder.id,
        level: node.level,
        hasChildren,
        expanded: isExpanded,
        parentId,
        posInSet: index + 1,
        setSize: nodes.length,
      });
      if (isExpanded) walk(node.children, node.folder.id);
    });
  };

  walk(tree.roots, null);
  return rows;
}

/**
 * Every id beneath a node in **this** tree, excluding the node itself.
 *
 * Deliberately derived from the built tree rather than from `parentId` links: after the
 * cycle guard has run, the tree is acyclic by construction, so this walk cannot spin. It
 * exists so counts can be aggregated once, and so the test suite can assert this tree and
 * `collectDescendantFolderIds` agree on well-formed input.
 */
export function descendantIdsOf(tree: FolderTree, folderId: string): ReadonlySet<string> {
  const node = tree.byId.get(folderId);
  const ids = new Set<string>();
  if (node === undefined) return ids;

  const walk = (nodes: readonly FolderNode[]): void => {
    for (const child of nodes) {
      ids.add(child.folder.id);
      walk(child.children);
    }
  };
  walk(node.children);
  return ids;
}

/** Ids of every folder that has at least one child, for an expand-all control. */
export function expandableIds(tree: FolderTree): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const [id, node] of tree.byId) {
    if (node.children.length > 0) ids.add(id);
  }
  return ids;
}

/** The ancestor ids of a node in this tree, root-first. Empty for a top-level row. */
export function ancestorIdsOf(tree: FolderTree, folderId: string): readonly string[] {
  const target = tree.byId.get(folderId);
  if (target === undefined) return [];

  const trail: string[] = [];
  const find = (nodes: readonly FolderNode[], chain: readonly string[]): boolean => {
    for (const node of nodes) {
      if (node.folder.id === folderId) {
        trail.push(...chain);
        return true;
      }
      if (find(node.children, [...chain, node.folder.id])) return true;
    }
    return false;
  };
  find(tree.roots, []);
  return trail;
}
