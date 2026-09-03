// SPDX-License-Identifier: GPL-3.0-or-later
import { FOLDER_PATH_SEPARATOR, normaliseFolderPath } from '@shared/model/import.js';
import type { Folder } from '@shared/model/vault-document.js';

/**
 * Reading the folder tree: children, ancestors, depth, and `/`-separated paths.
 *
 * Split from `folder-ops.ts` because these answer questions and that file makes changes.
 * Everything here takes a plain `readonly Folder[]` rather than a `VaultDocument`, which is
 * what lets the mutating operations call these against a half-built array mid-write without
 * having to fabricate a document around it.
 *
 * ## Every walk here is cycle-safe, and that is not defensive decoration
 *
 * Folder parentage arrives from a file that may have been merged, imported, restored from a
 * partial backup, or hand-edited. A cycle in it is a real state, not a hypothetical — see
 * `integrity.ts`, which reports them. A walk without a `seen` set would spin forever with
 * the UI thread inside it. A malformed vault must render badly, never hang.
 *
 * These functions **report** a broken tree; they never quietly repair one. `walkAncestors`
 * says how the walk ended, and `folderPath` refuses to produce a path from a broken chain
 * rather than returning a partial one, because a partial path is a confident lie about
 * where a folder lives.
 *
 * ## One index per pass, not one per call — N19
 *
 * Every walk needs the same `id → Folder` map, and each of them used to build its own. A
 * caller that walks once per folder therefore rebuilt it once per folder, which made
 * `checkOrganisation` quadratic and `folderPathsById` quadratic times the depth: measured at
 * `MAX_FOLDERS` (2,000) on a realistic shallow tree, 196 ms and 211 ms respectively, on the
 * main thread with no worker under it. So `indexFoldersById` and `childrenByParent` are
 * exported, every walk takes an optional prebuilt index, and the whole-tree functions build
 * one and pass it down. `folder-tree.test.ts` holds the budget that keeps it that way.
 *
 * That removes the cost rather than capping the input, which is why there is no
 * `too-many-folders` check here: with the index shared, a pass over the tree is linear in
 * the folders plus one sort, so there is no size at which a correct document hangs.
 *
 * ## Descendants live in `@shared/search/filter.ts`
 *
 * `collectDescendantFolderIds` was written there for the sidebar's "include subfolders"
 * filter, and it already does exactly what the cycle guard needs. Re-implementing it here
 * would be a second answer to the same question — see hard rule 8. It is imported instead.
 * It arguably belongs in a renderer-safe model module that both this file and the search
 * layer import; that move is recorded rather than made, because search is not this module's
 * to edit.
 */

/**
 * Total order on siblings: `order`, then id.
 *
 * The id tie-break is what makes it total. Two siblings sharing an `order` is possible
 * straight after a merge, and without a tie-break the rendered order of those two would
 * depend on array position — which changes on every save, so a folder would appear to
 * jump around on its own.
 */
export function compareSiblings(a: Folder, b: Folder): number {
  if (a.order !== b.order) return a.order - b.order;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function findFolder(folders: readonly Folder[], folderId: string): Folder | null {
  return folders.find((folder) => folder.id === folderId) ?? null;
}

/**
 * The `id → Folder` index every walk below needs.
 *
 * Exported so a caller doing more than one walk builds it once — see the N19 note in the
 * module header. Passing it is always optional and never changes an answer: it is the same
 * map the walk would have built for itself.
 */
export function indexFoldersById(folders: readonly Folder[]): ReadonlyMap<string, Folder> {
  return new Map(folders.map((folder) => [folder.id, folder]));
}

/** The direct children of `parentId` (`null` for the roots), in display order. */
export function childrenOf(folders: readonly Folder[], parentId: string | null): readonly Folder[] {
  return folders.filter((folder) => folder.parentId === parentId).sort(compareSiblings);
}

/**
 * Every parent's children at once, each group in the same display order `childrenOf` gives.
 *
 * The grouping form for a caller that wants all of them; `childrenOf` stays the single
 * lookup, so neither pays for the other. They are two traversals of one rule, which is the
 * drift hard rule 8 warns about — `folder-tree.test.ts` asserts they agree for every parent,
 * including a parent id that names no folder.
 *
 * Keys include a `parentId` naming no folder, exactly as `childrenOf` would answer for it:
 * orphans are grouped, never dropped, so nothing here papers over a dangling parent.
 */
export function childrenByParent(
  folders: readonly Folder[]
): ReadonlyMap<string | null, readonly Folder[]> {
  const groups = new Map<string | null, Folder[]>();
  for (const folder of folders) {
    const siblings = groups.get(folder.parentId);
    if (siblings === undefined) groups.set(folder.parentId, [folder]);
    else siblings.push(folder);
  }
  for (const siblings of groups.values()) siblings.sort(compareSiblings);
  return groups;
}

/** How a walk up the tree ended. `'root'` is the only healthy answer. */
export type AncestorStop = 'root' | 'missing-parent' | 'cycle';

export interface AncestorWalk {
  /** Root-first, excluding the folder itself. */
  readonly ids: readonly string[];
  readonly stoppedAt: AncestorStop;
}

/**
 * Walks from a folder to its root, reporting how the walk ended.
 *
 * The outcome is part of the answer rather than an exception, because both failure modes
 * are states a real vault can be in and every caller wants to handle them differently: a
 * depth check treats the ids it got as a lower bound, a path builder refuses outright, and
 * the integrity report wants to name the folders involved.
 */
export function walkAncestors(
  folders: readonly Folder[],
  folderId: string,
  index?: ReadonlyMap<string, Folder>
): AncestorWalk {
  const byId = index ?? indexFoldersById(folders);
  const start = byId.get(folderId);
  if (start === undefined) return { ids: [], stoppedAt: 'missing-parent' };

  const chain: string[] = [];
  const seen = new Set<string>([folderId]);
  let current: Folder = start;

  for (;;) {
    const parentId = current.parentId;
    if (parentId === null) return { ids: chain.reverse(), stoppedAt: 'root' };
    if (seen.has(parentId)) return { ids: chain.reverse(), stoppedAt: 'cycle' };

    const parent = byId.get(parentId);
    if (parent === undefined) return { ids: chain.reverse(), stoppedAt: 'missing-parent' };

    chain.push(parentId);
    seen.add(parentId);
    current = parent;
  }
}

/** Root-first ancestor ids, excluding the folder itself. Empty for a root or an unknown id. */
export function ancestorIds(folders: readonly Folder[], folderId: string): readonly string[] {
  return walkAncestors(folders, folderId).ids;
}

/**
 * Every distinct parent loop in the tree: the folders **in** each loop, sorted, once each.
 *
 * Derived from `walkAncestors` per folder before, and that was wrong in two ways at once.
 * The walk's `seen` set holds the whole path — the starting folder and the tail leading into
 * the loop — not the loop, so `f0 → f1 → f2 → f1` named `f0` as a member although `f0` is
 * healthy; and because the tail changes the member set, the same loop reached from two
 * different folders canonicalised to two different keys and was reported twice. The cut here
 * is the suffix of the path from the repeated id, which *is* the loop.
 *
 * Sorted members and a key-sorted result, so the report is a function of the tree rather
 * than of the order the folders happen to sit in the array — which is what makes two runs
 * either side of a merge comparable.
 *
 * Linear: folder parentage is a functional graph, so each folder is pushed onto exactly one
 * path across all the walks and marked settled after. No folder is walked twice, at any depth.
 */
export function findFolderCycles(folders: readonly Folder[]): readonly (readonly string[])[] {
  const byId = indexFoldersById(folders);
  const settled = new Set<string>();
  const cycles: string[][] = [];

  for (const start of folders) {
    if (settled.has(start.id)) continue;

    const path: string[] = [];
    const positions = new Map<string, number>();
    let currentId: string | null = start.id;

    while (currentId !== null && !settled.has(currentId)) {
      const repeatedAt = positions.get(currentId);
      if (repeatedAt !== undefined) {
        cycles.push([...path.slice(repeatedAt)].sort());
        break;
      }
      positions.set(currentId, path.length);
      path.push(currentId);
      // A parent naming no folder ends the walk without a loop; `integrity.ts` reports that
      // separately, and reporting it here as well would make one defect look like two.
      const parentId: string | null = byId.get(currentId)?.parentId ?? null;
      currentId = parentId !== null && byId.has(parentId) ? parentId : null;
    }

    for (const id of path) settled.add(id);
  }

  return cycles.sort((left, right) => (left.join() < right.join() ? -1 : 1));
}

/**
 * 1 for a root, 2 for its child, and so on. 0 for an unknown id.
 *
 * On a broken or cyclic chain this is a *lower bound*, which is the conservative direction:
 * the depth limit then refuses a move it might have allowed, rather than allowing one that
 * pushes a subtree past the limit.
 */
export function folderDepth(
  folders: readonly Folder[],
  folderId: string,
  index?: ReadonlyMap<string, Folder>
): number {
  const byId = index ?? indexFoldersById(folders);
  if (!byId.has(folderId)) return 0;
  return walkAncestors(folders, folderId, byId).ids.length + 1;
}

/**
 * Levels in the subtree rooted at `folderId`: 1 for a leaf.
 *
 * Needed by `moveFolder`, which must check the depth of the *deepest thing being carried*,
 * not just of the folder being dragged. Moving a three-level subtree one level from the
 * limit is the case a naive check waves through.
 */
export function subtreeHeight(folders: readonly Folder[], folderId: string): number {
  if (findFolder(folders, folderId) === null) return 0;

  const byParent = childrenByParent(folders);
  const seen = new Set<string>([folderId]);
  let frontier: string[] = [folderId];
  let height = 0;

  while (frontier.length > 0) {
    height += 1;
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of byParent.get(id) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        next.push(child.id);
      }
    }
    frontier = next;
  }
  return height;
}

/**
 * The folder's name and its ancestors', root-first — or `null` if the chain is broken.
 *
 * `null` rather than a partial path on purpose. `A/B/C` with `B` missing is not `A/C`, and
 * emitting that would file an import under a folder that is not the one it named.
 */
export function folderPathSegments(
  folders: readonly Folder[],
  folderId: string,
  index?: ReadonlyMap<string, Folder>
): readonly string[] | null {
  const byId = index ?? indexFoldersById(folders);
  const folder = byId.get(folderId);
  if (folder === undefined) return null;

  const walk = walkAncestors(folders, folderId, byId);
  if (walk.stoppedAt !== 'root') return null;

  const segments: string[] = [];
  for (const id of walk.ids) {
    const ancestor = byId.get(id);
    // Unreachable while the walk reports `root` — kept because the walk's contract is what
    // guarantees it, and a future change to the walk should surface here rather than as an
    // `undefined` in a path.
    if (ancestor === undefined) return null;
    segments.push(ancestor.name);
  }
  segments.push(folder.name);
  return segments;
}

/**
 * The `/`-separated path of a folder, in the convention `@shared/model/import.ts` defines.
 *
 * This is the exact inverse of `findFolderByPath`, and it stays the inverse only because
 * `assertValidFolderName` refuses a name containing a separator. A folder called `A/B`
 * would produce a path that reads as two folders, and the import commit stage would then
 * file records under a folder nobody created.
 */
export function folderPath(
  folders: readonly Folder[],
  folderId: string,
  index?: ReadonlyMap<string, Folder>
): string | null {
  const segments = folderPathSegments(folders, folderId, index);
  return segments === null ? null : segments.join(FOLDER_PATH_SEPARATOR);
}

/**
 * Every resolvable folder's path, keyed by id. Folders on a broken chain are omitted.
 *
 * The index is built once for the whole map rather than once per folder — this is the
 * function N19 measured worst, and it has three production callers (`import-service`'s
 * commit and undo stages), one of which calls it inside a loop.
 */
export function folderPathsById(folders: readonly Folder[]): ReadonlyMap<string, string> {
  const byId = indexFoldersById(folders);
  const paths = new Map<string, string>();
  for (const folder of folders) {
    const path = folderPath(folders, folder.id, byId);
    if (path !== null) paths.set(folder.id, path);
  }
  return paths;
}

/**
 * The folder at a `/`-separated path, matched **case-insensitively** segment by segment.
 *
 * Case-insensitive because the paths this resolves come from other people's exports.
 * LastPass writes `Work`, a hand-made tree has `work`, and treating those as two different
 * folders is how an import ends up with a sidebar containing both. Matching this way costs
 * nothing and is what a user means every time.
 *
 * When duplicate siblings exist — allowed, see `folder-ops.ts` — the lowest `(order, id)`
 * wins, so repeated calls resolve to the same folder rather than whichever the array
 * happened to list first.
 */
export function findFolderByPath(folders: readonly Folder[], path: string): Folder | null {
  const normalised = normaliseFolderPath(path);
  if (normalised === null) return null;

  let parentId: string | null = null;
  let found: Folder | null = null;

  for (const segment of normalised.split(FOLDER_PATH_SEPARATOR)) {
    const key = segment.toLowerCase();
    found =
      childrenOf(folders, parentId).find((folder) => folder.name.toLowerCase() === key) ?? null;
    if (found === null) return null;
    parentId = found.id;
  }
  return found;
}

/**
 * Another folder under the same parent already using this name, or `null`.
 *
 * Advisory. Duplicate sibling names are *not* rejected — see `createFolder` for why — so
 * this exists for the UI to warn with before it commits, and for `integrity.ts` to report
 * after the fact.
 */
export function siblingNameConflict(
  folders: readonly Folder[],
  parentId: string | null,
  name: string,
  exceptId?: string
): Folder | null {
  const key = name.trim().toLowerCase();
  return (
    childrenOf(folders, parentId).find(
      (folder) => folder.id !== exceptId && folder.name.toLowerCase() === key
    ) ?? null
  );
}

/**
 * Renumbers every sibling group to `0..n-1`, contiguously.
 *
 * Run after **every** write that touches the tree. The point is that drag-and-drop never
 * has to reason about gaps: an insertion index is always a position in a dense list, so
 * "drop between the second and third" is `index: 2` and not an average of two floats that
 * eventually run out of precision. It also means a document that arrived from a merge with
 * duplicate or sparse `order` values is dense again the first time anyone touches it.
 *
 * Array position is preserved and only `order` is rewritten, so a save does not reshuffle
 * the serialised file for cosmetic reasons. Orphans — a `parentId` naming no folder — are
 * grouped under that same missing key and renumbered among themselves: this normalises
 * ordering without papering over the dangling parent, which stays visible to `integrity.ts`.
 */
export function normaliseFolderOrder(folders: readonly Folder[]): readonly Folder[] {
  const groups = new Map<string | null, Folder[]>();
  for (const folder of folders) {
    const siblings = groups.get(folder.parentId);
    if (siblings === undefined) groups.set(folder.parentId, [folder]);
    else siblings.push(folder);
  }

  const orders = new Map<string, number>();
  for (const siblings of groups.values()) {
    [...siblings].sort(compareSiblings).forEach((folder, index) => orders.set(folder.id, index));
  }

  return folders.map((folder) => {
    const order = orders.get(folder.id) ?? folder.order;
    return order === folder.order ? folder : { ...folder, order };
  });
}
