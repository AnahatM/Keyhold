// SPDX-License-Identifier: GPL-3.0-or-later
import type { TreeRow } from './folder-tree-model.js';

/**
 * Arrow-key navigation for the ARIA tree pattern, as a pure function.
 *
 * The WAI-ARIA tree pattern is specific, and getting it half right is worse than not
 * claiming `role="tree"` at all — a screen reader announces "tree item, level 2, expanded"
 * and the user then presses Left expecting to collapse. So the whole key map lives here,
 * over a flat array of visible rows, with no DOM in sight:
 *
 *   Down / Up      the next / previous **visible** row (collapsed children are skipped)
 *   Right          expand a collapsed parent; on an expanded one, move to its first child
 *   Left           collapse an expanded parent; otherwise move to the parent row
 *   Home / End     first / last visible row
 *   Enter / Space  select
 *   *              expand every sibling of the focused row
 *
 * Being a pure function is the point: this is the part of a tree that is easy to get subtly
 * wrong and impossible to check by clicking, and `tree-keyboard.test.ts` drives it directly
 * without needing a renderer or a testing library.
 *
 * Focus itself is roving: exactly one row carries `tabIndex=0`, the rest `-1`, so Tab moves
 * past the whole tree in one press rather than through every folder.
 */

export type TreeKeyAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'focus'; readonly id: string }
  | { readonly kind: 'expand'; readonly id: string }
  | { readonly kind: 'collapse'; readonly id: string }
  | { readonly kind: 'expand-siblings'; readonly ids: readonly string[] }
  | { readonly kind: 'select'; readonly id: string };

const NONE: TreeKeyAction = { kind: 'none' };

function rowAt(rows: readonly TreeRow[], index: number): TreeRow | undefined {
  return index < 0 || index >= rows.length ? undefined : rows[index];
}

function focusOn(row: TreeRow | undefined): TreeKeyAction {
  return row === undefined ? NONE : { kind: 'focus', id: row.id };
}

/**
 * The keys the tree consumes. A key not in this set must be left alone so that Tab, typing
 * into a rename field, and the app's own shortcuts still work.
 */
export const HANDLED_TREE_KEYS: readonly string[] = [
  'ArrowDown',
  'ArrowUp',
  'ArrowRight',
  'ArrowLeft',
  'Home',
  'End',
  'Enter',
  ' ',
  '*',
];

export function isHandledTreeKey(key: string): boolean {
  return HANDLED_TREE_KEYS.includes(key);
}

export function treeKeyAction(
  rows: readonly TreeRow[],
  focusedId: string | null,
  key: string
): TreeKeyAction {
  if (rows.length === 0) return NONE;

  const index = focusedId === null ? -1 : rows.findIndex((row) => row.id === focusedId);
  // Focus sitting on a row that no longer exists — a folder deleted from under the cursor —
  // is a real state. Any navigation key then lands on the first row rather than doing
  // nothing, which is what stops the tree becoming keyboard-dead after a delete.
  if (index === -1) {
    return isHandledTreeKey(key) ? focusOn(rows[0]) : NONE;
  }

  const row = rows[index];
  if (row === undefined) return NONE;

  switch (key) {
    case 'ArrowDown':
      return focusOn(rowAt(rows, index + 1));

    case 'ArrowUp':
      return focusOn(rowAt(rows, index - 1));

    case 'ArrowRight': {
      if (!row.hasChildren) return NONE;
      if (!row.expanded) return { kind: 'expand', id: row.id };
      // Already open: the next row is its first child, because the flattening put it there.
      return focusOn(rowAt(rows, index + 1));
    }

    case 'ArrowLeft': {
      if (row.hasChildren && row.expanded) return { kind: 'collapse', id: row.id };
      if (row.parentId === null) return NONE;
      return { kind: 'focus', id: row.parentId };
    }

    case 'Home':
      return focusOn(rows[0]);

    case 'End':
      return focusOn(rows.at(-1));

    case 'Enter':
    case ' ':
      return { kind: 'select', id: row.id };

    case '*': {
      const ids = rows
        .filter((sibling) => sibling.parentId === row.parentId && sibling.hasChildren)
        .map((sibling) => sibling.id);
      return ids.length === 0 ? NONE : { kind: 'expand-siblings', ids };
    }

    default:
      return NONE;
  }
}

/**
 * Where focus should go after the focused row disappears.
 *
 * Called after a delete. The next row at the same position is the natural landing place —
 * it is where the eye already is — falling back to the previous row, then to nothing.
 */
export function focusAfterRemoval(
  rowsBefore: readonly TreeRow[],
  rowsAfter: readonly TreeRow[],
  removedId: string
): string | null {
  const index = rowsBefore.findIndex((row) => row.id === removedId);
  if (index === -1) return rowsAfter[0]?.id ?? null;

  const stillPresent = (id: string | undefined): string | null =>
    id !== undefined && rowsAfter.some((row) => row.id === id) ? id : null;

  for (let offset = index; offset < rowsBefore.length; offset += 1) {
    const candidate = stillPresent(rowsBefore[offset]?.id);
    if (candidate !== null) return candidate;
  }
  for (let offset = index - 1; offset >= 0; offset -= 1) {
    const candidate = stillPresent(rowsBefore[offset]?.id);
    if (candidate !== null) return candidate;
  }
  return rowsAfter[0]?.id ?? null;
}

/**
 * Expands every ancestor of a folder so it can be revealed.
 *
 * Needed whenever something outside the tree selects a folder — a record's detail pane
 * linking to the folder it is in, say. Selecting a row nested inside three collapsed
 * parents and not opening them would look like the click did nothing.
 */
export function expandToReveal(
  expanded: ReadonlySet<string>,
  ancestorIds: readonly string[]
): ReadonlySet<string> {
  const next = new Set(expanded);
  for (const id of ancestorIds) next.add(id);
  return next;
}
