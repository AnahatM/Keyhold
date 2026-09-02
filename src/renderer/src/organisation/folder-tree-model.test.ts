// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { collectDescendantFolderIds } from '@shared/search/filter.js';
import type { Folder } from '@shared/model/vault-document.js';
import {
  MAX_RENDER_DEPTH,
  ancestorIdsOf,
  buildFolderTree,
  descendantIdsOf,
  expandableIds,
  flattenVisible,
  type FolderNode,
} from './folder-tree-model.js';
import { folder, healthyFolders } from './test-fixtures.js';

/**
 * The tree builder is the one part of the sidebar that can hang the app, so most of what is
 * here is hostile input rather than happy-path structure: cycles, missing parents, duplicate
 * ids, and a chain deep enough to blow a stack.
 *
 * The equivalence test against `collectDescendantFolderIds` is the guard that keeps this
 * module and `@shared/search/filter.ts` from drifting into two different answers to "what is
 * under this folder" — which is the failure hard rule 8 exists to prevent.
 */

describe('a well-formed tree', () => {
  it('nests folders and numbers the levels from 1', () => {
    const tree = buildFolderTree(healthyFolders());

    expect(tree.problems).toEqual([]);
    expect(tree.roots.map((node) => node.folder.id)).toEqual(['w', 'h']);
    expect(tree.byId.get('w')?.level).toBe(1);
    expect(tree.byId.get('b')?.level).toBe(2);
    expect(tree.byId.get('bp')?.level).toBe(3);
  });

  it('orders siblings by order, then by id, so equal orders do not reshuffle', () => {
    // Both children claim order 0 — a normal post-merge state.
    const tree = buildFolderTree([
      folder('root', 'Root', null, 0),
      folder('zebra', 'Zebra', 'root', 0),
      folder('alpha', 'Alpha', 'root', 0),
    ]);

    expect(tree.byId.get('root')?.children.map((node) => node.folder.id)).toEqual([
      'alpha',
      'zebra',
    ]);
  });

  it('builds a root-first path for each folder', () => {
    const tree = buildFolderTree(healthyFolders());
    expect(tree.byId.get('bp')?.path).toEqual(['Work', 'Banking', 'Personal']);
  });

  it('reports ancestors root-first', () => {
    const tree = buildFolderTree(healthyFolders());
    expect(ancestorIdsOf(tree, 'bp')).toEqual(['w', 'b']);
    expect(ancestorIdsOf(tree, 'w')).toEqual([]);
    expect(ancestorIdsOf(tree, 'nope')).toEqual([]);
  });

  it('agrees with the shared descendant walk for every folder', () => {
    // The anti-drift guard. `collectDescendantFolderIds` includes the root itself; this
    // tree's version does not, which is the only difference there is allowed to be.
    const folders = healthyFolders();
    const tree = buildFolderTree(folders);

    for (const candidate of folders) {
      const shared = new Set(collectDescendantFolderIds(folders, candidate.id));
      shared.delete(candidate.id);
      expect([...descendantIdsOf(tree, candidate.id)].sort()).toEqual([...shared].sort());
    }
  });
});

describe('a tree that cannot be trusted', () => {
  it('renders a cycle instead of hanging, and says so', () => {
    // a → b → a. Neither has a path to a root.
    const tree = buildFolderTree([folder('a', 'A', 'b', 0), folder('b', 'B', 'a', 0)]);

    expect(tree.problems.map((problem) => problem.kind)).toContain('cycle');
    // Both folders are still reachable in the UI — nothing is silently dropped.
    expect([...tree.byId.keys()].sort()).toEqual(['a', 'b']);
    expect(tree.roots).toHaveLength(1);
  });

  it('does not descend into a cycle twice', () => {
    const tree = buildFolderTree([
      folder('a', 'A', 'c', 0),
      folder('b', 'B', 'a', 0),
      folder('c', 'C', 'b', 0),
    ]);

    // One entry point into the ring, and each member appears exactly once. Walked through the
    // module's own `FolderNode` rather than a structural stand-in, so the walk is checked
    // against the real shape instead of against a local description of it.
    const seen: string[] = [];
    const walk = (nodes: readonly FolderNode[]): void => {
      for (const node of nodes) {
        seen.push(node.folder.id);
        walk(node.children);
      }
    };
    walk(tree.roots);
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
  });

  it('terminates on a large cycle within a hard time budget', () => {
    // The bounded-evidence version of "never hang": 500 folders in one ring. Without a
    // `seen` set this either spins or overflows; with one it is linear.
    const ring: Folder[] = [];
    for (let index = 0; index < 500; index += 1) {
      ring.push(folder(`f${index}`, `F${index}`, `f${(index + 1) % 500}`, 0));
    }

    const started = performance.now();
    const tree = buildFolderTree(ring);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(tree.byId.size).toBe(500);

    // Counted over the rendered nodes, not over `byId`.
    //
    // This line is the one that actually pins the `visited` set. `byId` is keyed by folder
    // id, so a folder rendered in twenty places still counts once there, and the timing
    // assertion above is satisfied by MAX_RENDER_DEPTH alone — removing the cycle guard
    // leaves both of them green. Walking the tree is what notices that each ring member is
    // on screen exactly once instead of five hundred entry points each dragging 63 copies
    // of their successors behind them.
    let rendered = 0;
    const count = (nodes: readonly FolderNode[]): void => {
      for (const node of nodes) {
        rendered += 1;
        count(node.children);
      }
    };
    count(tree.roots);
    expect(rendered).toBe(500);
  });

  it('promotes a folder whose parent does not exist, rather than hiding it', () => {
    const tree = buildFolderTree([folder('orphan', 'Orphan', 'ghost', 0)]);

    expect(tree.problems).toHaveLength(1);
    expect(tree.problems[0]?.kind).toBe('missing-parent');
    expect(tree.roots.map((node) => node.folder.id)).toEqual(['orphan']);
    expect(tree.roots[0]?.attachment).toBe('missing-parent');
  });

  it('keeps an orphan’s own subtree underneath it', () => {
    const tree = buildFolderTree([
      folder('orphan', 'Orphan', 'ghost', 0),
      folder('child', 'Child', 'orphan', 0),
    ]);

    expect(tree.byId.get('orphan')?.children.map((node) => node.folder.id)).toEqual(['child']);
    // The child is not also reported as stranded.
    expect(tree.problems).toHaveLength(1);
  });

  it('keeps only the first of two folders sharing an id, and reports the clash', () => {
    const tree = buildFolderTree([folder('x', 'First', null, 0), folder('x', 'Second', null, 1)]);

    expect(tree.byId.get('x')?.folder.name).toBe('First');
    expect(tree.problems.map((problem) => problem.kind)).toEqual(['duplicate-id']);
    expect(tree.roots).toHaveLength(1);
  });

  it('stops descending past the render depth instead of overflowing the stack', () => {
    const chain: Folder[] = [folder('d0', 'D0', null, 0)];
    for (let index = 1; index < MAX_RENDER_DEPTH + 20; index += 1) {
      chain.push(folder(`d${index}`, `D${index}`, `d${index - 1}`, 0));
    }

    const tree = buildFolderTree(chain);
    expect(tree.problems.map((problem) => problem.kind)).toContain('depth-limit');

    let depth = 0;
    let node = tree.roots[0];
    while (node !== undefined) {
      depth += 1;
      node = node.children[0];
    }
    expect(depth).toBe(MAX_RENDER_DEPTH);
  });
});

describe('the visible projection', () => {
  it('shows only roots when nothing is expanded', () => {
    const rows = flattenVisible(buildFolderTree(healthyFolders()), new Set());
    expect(rows.map((row) => row.id)).toEqual(['w', 'h']);
  });

  it('reveals children of expanded folders, in order', () => {
    const tree = buildFolderTree(healthyFolders());
    const rows = flattenVisible(tree, new Set(['w', 'b']));
    expect(rows.map((row) => row.id)).toEqual(['w', 'b', 'bp', 'c', 'h']);
  });

  it('does not claim a leaf is expandable', () => {
    const rows = flattenVisible(buildFolderTree(healthyFolders()), new Set(['w', 'b', 'bp']));
    const leaf = rows.find((row) => row.id === 'bp');
    expect(leaf?.hasChildren).toBe(false);
    // A leaf must never carry aria-expanded, which is what `hasChildren: false` drives.
    expect(leaf?.expanded).toBe(false);
  });

  it('numbers each row within its own sibling set, for aria-posinset and aria-setsize', () => {
    const rows = flattenVisible(buildFolderTree(healthyFolders()), new Set(['w']));
    const banking = rows.find((row) => row.id === 'b');
    expect(banking).toMatchObject({ posInSet: 1, setSize: 2, level: 2, parentId: 'w' });
  });

  it('ignores an expanded id that names a folder with no children', () => {
    const rows = flattenVisible(buildFolderTree(healthyFolders()), new Set(['h']));
    expect(rows.map((row) => row.id)).toEqual(['w', 'h']);
  });

  it('lists exactly the folders that can be expanded', () => {
    expect([...expandableIds(buildFolderTree(healthyFolders()))].sort()).toEqual(['b', 'w']);
  });
});
