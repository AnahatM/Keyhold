// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Folder } from '@shared/model/vault-document.js';
import {
  childrenByParent,
  childrenOf,
  findFolderCycles,
  folderPathsById,
  indexFoldersById,
  walkAncestors,
} from './folder-tree.js';

/**
 * The reading half of the folder tree, and the two indexes every walk in it now shares.
 *
 * The subject here is **cost and cycle shape**, not "does it find the parent" — the walks
 * themselves are exercised through `folder-ops.test.ts`, which drives them the way the
 * mutating operations do. What is asserted below is what N19 and the cycle-membership
 * defect found next to it are about: that a pass over the tree builds its index once, that
 * the two ways of asking "who are this parent's children" cannot drift apart, and that a
 * cycle is exactly the folders in the loop.
 */

const folder = (id: string, parentId: string | null = null, order = 0): Folder => ({
  id,
  name: id.toUpperCase(),
  parentId,
  order,
});

/** A chain `f0 → f1 → … → f(n-1) → root`. Deep, healthy, and the worst case for a walk. */
function chain(length: number): readonly Folder[] {
  const folders: Folder[] = [];
  for (let index = 0; index < length; index += 1) {
    folders.push(folder(`f${index}`, index === 0 ? null : `f${index - 1}`));
  }
  return folders;
}

describe('the two indexes', () => {
  it('childrenByParent agrees with childrenOf for every parent', () => {
    // Two traversals answering one question is exactly the drift hard rule 8 is about. They
    // are separate because a single lookup should not pay for the whole grouping — so this
    // asserts they stay the same answer, including the sibling order.
    const folders = [
      folder('a'),
      folder('b', null, 1),
      folder('c', 'a', 1),
      folder('d', 'a', 0),
      folder('e', 'gone'),
    ];
    const grouped = childrenByParent(folders);

    for (const parentId of [null, 'a', 'b', 'gone', 'nobody']) {
      expect([...(grouped.get(parentId) ?? [])]).toEqual([...childrenOf(folders, parentId)]);
    }
  });

  it('indexFoldersById is the map every walk would otherwise rebuild', () => {
    const folders = chain(4);
    const byId = indexFoldersById(folders);
    expect(byId.size).toBe(4);
    expect(byId.get('f2')?.parentId).toBe('f1');
    // Passing the shared index cannot change the answer; that is the whole premise of N19's
    // fix, so it is asserted rather than assumed.
    expect(walkAncestors(folders, 'f3', byId)).toEqual(walkAncestors(folders, 'f3'));
  });
});

describe('cycles are the loop and nothing else', () => {
  it('excludes the tail that merely points into a cycle', () => {
    // N19's neighbour: the walk's `seen` set holds the whole path, so a folder that only
    // points at a loop was being counted as a member of it. `f0` is healthy.
    const folders = [folder('f0', 'f1'), folder('f1', 'f2'), folder('f2', 'f1')];
    expect(findFolderCycles(folders)).toEqual([['f1', 'f2']]);
  });

  it('reports one entry per loop however many folders lead into it', () => {
    const folders = [
      folder('t1', 'x'),
      folder('t2', 'x'),
      folder('x', 'y'),
      folder('y', 'x'),
      folder('lone'),
    ];
    expect(findFolderCycles(folders)).toEqual([['x', 'y']]);
  });

  it('finds two disjoint loops separately', () => {
    const folders = [
      folder('a', 'b'),
      folder('b', 'a'),
      folder('c', 'd'),
      folder('d', 'e'),
      folder('e', 'c'),
    ];
    expect(findFolderCycles(folders)).toEqual([
      ['a', 'b'],
      ['c', 'd', 'e'],
    ]);
  });

  it('finds nothing in a healthy or merely broken tree', () => {
    expect(findFolderCycles(chain(50))).toEqual([]);
    expect(findFolderCycles([folder('a', 'gone'), folder('b', 'a')])).toEqual([]);
    expect(findFolderCycles([])).toEqual([]);
  });

  it('counts a self-parented folder as a loop of one', () => {
    expect(findFolderCycles([folder('a', 'a')])).toEqual([['a']]);
  });
});

describe('cost — N19', () => {
  /**
   * The old shape rebuilt a `Map` of every folder on every call, once per folder, so a pass
   * over the tree was quadratic in the folder count with the main thread inside it.
   *
   * **The shape of the fixture is the whole guard, and the first version of it was wrong.**
   * A deep chain looked like the obvious worst case, but walking every folder's ancestors in
   * an n-deep chain is quadratic in walk *steps* whether the index is shared or not, so the
   * index rebuild is only a fraction of the cost and the budget survived fault injection.
   * A wide, shallow tree — which is also the only shape a real vault has, `MAX_FOLDER_DEPTH`
   * being 16 — isolates the term that actually changed: walking is O(n·depth) either way, so
   * the per-call rebuild is the entire difference. Measured on the old code at n = 2,000 it
   * was 196 ms, and it grows fourfold each time the vault doubles.
   *
   * The budget is generous against the linear cost (single-digit milliseconds) because a
   * wall-clock assertion on a shared runner has to be, and still leaves the injected bug
   * failing by several times over.
   */
  const WIDE = 4_000;
  const BUDGET_MS = 250;

  /** `WIDE` folders in groups of twenty, three levels deep. What a large real vault is. */
  function wide(count: number): readonly Folder[] {
    const folders: Folder[] = [];
    for (let index = 0; index < count; index += 1) {
      folders.push(folder(`w${index}`, index < 20 ? null : `w${Math.floor(index / 20) - 1}`));
    }
    return folders;
  }

  it('walks every folder in a 4,000-folder tree without rebuilding the index per folder', () => {
    const folders = wide(WIDE);
    const started = performance.now();
    const byId = indexFoldersById(folders);
    for (const item of folders) walkAncestors(folders, item.id, byId);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });

  it('builds every folder path in one pass', () => {
    const folders = wide(WIDE);
    const started = performance.now();
    const paths = folderPathsById(folders);
    const elapsed = performance.now() - started;
    expect(paths.size).toBe(WIDE);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('terminates and stays correct on a pathologically deep chain', () => {
    // Not a real vault shape — `MAX_FOLDER_DEPTH` refuses it — but a merge or a hand-edited
    // export can produce one, and `folder-tree.ts` promises such a document renders badly
    // rather than hanging.
    //
    // **Deliberately not a budget.** `folderPathsById` over an n-deep chain emits n paths
    // whose average length is n/2 segments, so its *output* is quadratic in n whatever the
    // index does; a wall-clock assertion here would be measuring the size of the answer, not
    // the cost of computing it, and it was flaky under a loaded runner for exactly that
    // reason. The two fixtures above are where the cost is actually guarded.
    const folders = chain(1_000);
    const paths = folderPathsById(folders);
    expect(paths.size).toBe(1_000);
    expect(paths.get('f0')).toBe('F0');
    expect(paths.get('f3')).toBe('F0/F1/F2/F3');
  });
});
