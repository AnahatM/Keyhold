// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { importFolderId } from '@shared/model/import.js';
import {
  emptyVaultDocument,
  type Folder,
  type VaultDocument,
} from '@shared/model/vault-document.js';
import { OrganisationError } from './errors.js';
import {
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_NAME_LENGTH,
  createFolder,
  deleteFolder,
  findOrCreateFolderPath,
  findOrCreateFolderPaths,
  moveFolder,
  renameFolder,
  reorderFolder,
  type OrganisationContext,
} from './folder-ops.js';
import {
  ancestorIds,
  childrenOf,
  findFolderByPath,
  folderDepth,
  folderPath,
  normaliseFolderOrder,
  siblingNameConflict,
  subtreeHeight,
  walkAncestors,
} from './folder-tree.js';
import { addRecord, credential } from './test-support.js';

/**
 * Folder operations.
 *
 * Pure functions over a document, which is what makes them worth testing directly: the
 * rules about what a tree may look like — no cycles, no orphans, no gaps in the ordering —
 * are the part most likely to acquire a subtle bug, and none of them need a key or a file
 * to exercise.
 *
 * The cases that matter most are the ones where the wrong behaviour is *invisible*: a move
 * that detaches a subtree, a delete that leaves records pointing nowhere, an ordering that
 * drifts. Those are tested hardest.
 */

let nextId = 0;
const context = (): OrganisationContext => ({ newId: () => `f${++nextId}` });

/** Builds a tree from `parentName -> childName` edges, returning ids by name. */
function tree(paths: readonly string[]): {
  document: VaultDocument;
  id: (name: string) => string;
} {
  let document = emptyVaultDocument();
  const ids = new Map<string, string>();

  for (const path of paths) {
    const segments = path.split('/');
    let parentId: string | null = null;
    for (const segment of segments) {
      const existing = ids.get(segment);
      if (existing !== undefined) {
        parentId = existing;
        continue;
      }
      const created = createFolder(document, { name: segment, parentId }, context());
      document = created.document;
      ids.set(segment, created.folder.id);
      parentId = created.folder.id;
    }
  }

  return {
    document,
    id: (name) => {
      const found = ids.get(name);
      if (found === undefined) throw new Error(`no folder named ${name} in the fixture`);
      return found;
    },
  };
}

const orders = (document: VaultDocument, parentId: string | null): readonly number[] =>
  childrenOf(document.folders, parentId).map((folder) => folder.order);

const names = (document: VaultDocument, parentId: string | null): readonly string[] =>
  childrenOf(document.folders, parentId).map((folder) => folder.name);

describe('creating a folder', () => {
  it('places a new root at the end and numbers siblings contiguously', () => {
    let document = emptyVaultDocument();
    for (const name of ['A', 'B', 'C']) {
      document = createFolder(document, { name }, context()).document;
    }

    expect(names(document, null)).toEqual(['A', 'B', 'C']);
    expect(orders(document, null)).toEqual([0, 1, 2]);
  });

  it('inserts at a requested index and renumbers everything after it', () => {
    let document = emptyVaultDocument();
    for (const name of ['A', 'B', 'C']) {
      document = createFolder(document, { name }, context()).document;
    }
    document = createFolder(document, { name: 'New', index: 1 }, context()).document;

    expect(names(document, null)).toEqual(['A', 'New', 'B', 'C']);
    // Contiguous, so a later drop index is a position in a dense list and never an average
    // of two numbers that eventually run out of precision.
    expect(orders(document, null)).toEqual([0, 1, 2, 3]);
  });

  it('trims the name but does not otherwise edit it', () => {
    const { folder } = createFolder(emptyVaultDocument(), { name: '  Work  Stuff ' }, context());
    expect(folder.name).toBe('Work  Stuff');
  });

  it('refuses a name that is empty, over the cap, slashed, or carrying a control character', () => {
    const document = emptyVaultDocument();
    const reject = (name: string): OrganisationError => {
      try {
        createFolder(document, { name }, context());
      } catch (error) {
        if (error instanceof OrganisationError) return error;
      }
      throw new Error(`expected "${name}" to be refused`);
    };

    expect(reject('   ').code).toBe('INVALID_NAME');
    expect(reject('x'.repeat(MAX_FOLDER_NAME_LENGTH + 1)).code).toBe('INVALID_NAME');
    // The separator ban is what keeps folderPath and findFolderByPath exact inverses.
    expect(reject('Work/Clients').code).toBe('INVALID_NAME');
    expect(reject('Work\\Clients').code).toBe('INVALID_NAME');
    expect(reject(`Work${String.fromCharCode(0)}`).code).toBe('INVALID_NAME');
    // In the middle: a trailing tab is whitespace and is trimmed before the check sees it,
    // so only an interior one proves the guard is doing anything.
    expect(reject(`Work${String.fromCharCode(9)}Clients`).code).toBe('INVALID_NAME');
  });

  it('refuses a parent that does not exist', () => {
    expect(() =>
      createFolder(emptyVaultDocument(), { name: 'A', parentId: 'nope' }, context())
    ).toThrow(expect.objectContaining({ code: 'NO_SUCH_FOLDER' }));
  });

  it('refuses to nest past the depth limit', () => {
    let document = emptyVaultDocument();
    let parentId: string | null = null;
    for (let level = 0; level < MAX_FOLDER_DEPTH; level += 1) {
      const created = createFolder(document, { name: `L${level}`, parentId }, context());
      document = created.document;
      parentId = created.folder.id;
    }
    expect(folderDepth(document.folders, parentId ?? '')).toBe(MAX_FOLDER_DEPTH);

    expect(() => createFolder(document, { name: 'too deep', parentId }, context())).toThrow(
      expect.objectContaining({ code: 'FOLDER_TOO_DEEP' })
    );
  });

  it('allows duplicate sibling names, and reports the conflict rather than preventing it', () => {
    // The decision, stated in folder-ops.ts: a folder's identity is its id, and enforcing
    // name uniqueness would make a merge, a restore, or an import fail rather than land.
    let document = emptyVaultDocument();
    document = createFolder(document, { name: 'Work' }, context()).document;
    const second = createFolder(document, { name: 'work' }, context());
    document = second.document;

    expect(document.folders).toHaveLength(2);
    expect(siblingNameConflict(document.folders, null, 'WORK', second.folder.id)?.name).toBe(
      'Work'
    );
    // Resolution stays deterministic: lowest (order, id) wins, which is the first created.
    expect(findFolderByPath(document.folders, 'work')?.order).toBe(0);
  });
});

describe('renaming a folder', () => {
  it('renames in place and leaves everything else alone', () => {
    const { document, id } = tree(['A/B']);
    const renamed = renameFolder(document, id('B'), '  Beta ');

    expect(renamed.folders.find((folder) => folder.id === id('B'))?.name).toBe('Beta');
    expect(folderPath(renamed.folders, id('B'))).toBe('A/Beta');
  });

  it('returns the same document for a no-op rename', () => {
    const { document, id } = tree(['A']);
    expect(renameFolder(document, id('A'), 'A')).toBe(document);
  });

  it('refuses an unknown folder', () => {
    expect(() => renameFolder(emptyVaultDocument(), 'nope', 'X')).toThrow(
      expect.objectContaining({ code: 'NO_SUCH_FOLDER' })
    );
  });
});

describe('moving a folder — the cycle guard', () => {
  it('refuses to make a folder its own parent', () => {
    const { document, id } = tree(['A']);
    expect(() => moveFolder(document, id('A'), id('A'))).toThrow(
      expect.objectContaining({ code: 'FOLDER_CYCLE' })
    );
  });

  it('refuses a move into a direct child', () => {
    const { document, id } = tree(['A/B']);
    expect(() => moveFolder(document, id('A'), id('B'))).toThrow(
      expect.objectContaining({ code: 'FOLDER_CYCLE' })
    );
  });

  it('refuses a move into a deep descendant', () => {
    // The case a shallow "is the target my child?" check waves through. Detaching this
    // subtree would leave four folders and their records in the file and in no sidebar.
    const { document, id } = tree(['A/B/C/D/E']);
    expect(() => moveFolder(document, id('A'), id('E'))).toThrow(
      expect.objectContaining({ code: 'FOLDER_CYCLE' })
    );
  });

  it('refuses rather than silently doing nothing', () => {
    // A drag that appears to do nothing is a bug report nobody can write.
    const { document, id } = tree(['A/B']);
    let thrown: unknown = null;
    try {
      moveFolder(document, id('A'), id('B'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OrganisationError);
  });

  it('allows a move that only looks like a cycle — a sibling with the same name', () => {
    const { document, id } = tree(['A/B', 'C']);
    const moved = moveFolder(document, id('C'), id('B'));
    expect(folderPath(moved.folders, id('C'))).toBe('A/B/C');
  });
});

describe('moving a folder', () => {
  it('reparents and renumbers both the old and the new sibling group', () => {
    const { document, id } = tree(['A/A1', 'A/A2', 'B/B1']);
    const moved = moveFolder(document, id('A1'), id('B'));

    expect(names(moved, id('A'))).toEqual(['A2']);
    expect(orders(moved, id('A'))).toEqual([0]);
    expect(names(moved, id('B'))).toEqual(['B1', 'A1']);
    expect(orders(moved, id('B'))).toEqual([0, 1]);
  });

  it('honours an insertion index', () => {
    const { document, id } = tree(['P/X', 'P/Y', 'P/Z', 'Q']);
    const moved = moveFolder(document, id('Q'), id('P'), { index: 1 });
    expect(names(moved, id('P'))).toEqual(['X', 'Q', 'Y', 'Z']);
    expect(orders(moved, id('P'))).toEqual([0, 1, 2, 3]);
  });

  it('promotes a folder to the root', () => {
    const { document, id } = tree(['A/B']);
    const moved = moveFolder(document, id('B'), null);
    expect(ancestorIds(moved.folders, id('B'))).toEqual([]);
    expect(folderPath(moved.folders, id('B'))).toBe('B');
  });

  it('measures the depth of the subtree being carried, not just the folder dragged', () => {
    // Three levels of A, dropped one level short of the limit: the folder itself would fit
    // and its grandchild would not. Checking only the dragged folder waves this through.
    let document = emptyVaultDocument();
    let deepestId: string | null = null;
    for (let level = 0; level < MAX_FOLDER_DEPTH - 2; level += 1) {
      const created = createFolder(document, { name: `L${level}`, parentId: deepestId }, context());
      document = created.document;
      deepestId = created.folder.id;
    }

    const a = createFolder(document, { name: 'A' }, context());
    const b = createFolder(a.document, { name: 'B', parentId: a.folder.id }, context());
    const c = createFolder(b.document, { name: 'C', parentId: b.folder.id }, context());
    document = c.document;

    expect(subtreeHeight(document.folders, a.folder.id)).toBe(3);
    expect(() => moveFolder(document, a.folder.id, deepestId)).toThrow(
      expect.objectContaining({ code: 'FOLDER_TOO_DEEP' })
    );
  });

  it('reorders within the current parent', () => {
    const { document, id } = tree(['P/X', 'P/Y', 'P/Z']);
    const moved = reorderFolder(document, id('Z'), 0);
    expect(names(moved, id('P'))).toEqual(['Z', 'X', 'Y']);
    expect(orders(moved, id('P'))).toEqual([0, 1, 2]);
  });
});

describe('deleting a folder', () => {
  const withRecords = (): { document: VaultDocument; id: (name: string) => string } => {
    const built = tree(['A/B/C', 'Z']);
    let document = built.document;
    document = addRecord(document, credential('in-A', { folderId: built.id('A') }));
    document = addRecord(document, credential('in-B', { folderId: built.id('B') }));
    document = addRecord(document, credential('in-C', { folderId: built.id('C') }));
    document = addRecord(document, credential('in-Z', { folderId: built.id('Z') }));
    return { document, id: built.id };
  };

  it('reparent: children and records rise to the deleted folder’s parent', () => {
    const { document, id } = withRecords();
    const after = deleteFolder(document, id('B'), 'reparent');

    expect(after.folders.some((folder) => folder.id === id('B'))).toBe(false);
    expect(after.folders.find((folder) => folder.id === id('C'))?.parentId).toBe(id('A'));

    const byTitle = (title: string): string | null =>
      after.records.find((record) => record.title === title)?.folderId ?? null;
    expect(byTitle('in-B')).toBe(id('A'));
    expect(byTitle('in-C')).toBe(id('C'));
    expect(byTitle('in-A')).toBe(id('A'));
  });

  it('reparent at the root: children become roots and records become unfiled', () => {
    const { document, id } = withRecords();
    const after = deleteFolder(document, id('A'), 'reparent');

    expect(after.folders.find((folder) => folder.id === id('B'))?.parentId).toBeNull();
    expect(after.records.find((record) => record.title === 'in-A')?.folderId).toBeNull();
  });

  it('unfile: the whole subtree goes, and every record beneath it goes to no folder', () => {
    const { document, id } = withRecords();
    const after = deleteFolder(document, id('A'), 'unfile');

    expect(after.folders.map((folder) => folder.id)).toEqual([id('Z')]);
    const folderOf = (title: string): string | null =>
      after.records.find((record) => record.title === title)?.folderId ?? null;
    expect(folderOf('in-A')).toBeNull();
    expect(folderOf('in-B')).toBeNull();
    expect(folderOf('in-C')).toBeNull();
    // Untouched: it was never in the deleted branch.
    expect(folderOf('in-Z')).toBe(id('Z'));
  });

  it('never destroys a record under either policy', () => {
    // Folder deletion is not a route around the trash and its tombstone.
    const { document, id } = withRecords();
    expect(deleteFolder(document, id('A'), 'reparent').records).toHaveLength(4);
    expect(deleteFolder(document, id('A'), 'unfile').records).toHaveLength(4);
  });

  it('leaves no record pointing at a folder that is gone', () => {
    const { document, id } = withRecords();
    for (const policy of ['reparent', 'unfile'] as const) {
      const after = deleteFolder(document, id('A'), policy);
      const live = new Set(after.folders.map((folder) => folder.id));
      for (const record of after.records) {
        expect(record.folderId === null || live.has(record.folderId)).toBe(true);
      }
    }
  });

  it('refuses an unknown folder', () => {
    expect(() => deleteFolder(emptyVaultDocument(), 'nope', 'unfile')).toThrow(
      expect.objectContaining({ code: 'NO_SUCH_FOLDER' })
    );
  });
});

describe('paths', () => {
  it('is the exact inverse of findFolderByPath', () => {
    const { document, id } = tree(['Work/Clients/Acme', 'Personal']);
    for (const folder of document.folders) {
      const path = folderPath(document.folders, folder.id);
      expect(path).not.toBeNull();
      expect(findFolderByPath(document.folders, path ?? '')?.id).toBe(folder.id);
    }
    expect(folderPath(document.folders, id('Acme'))).toBe('Work/Clients/Acme');
  });

  it('matches a path case-insensitively and across either separator', () => {
    const { document, id } = tree(['Work/Clients']);
    expect(findFolderByPath(document.folders, 'work/CLIENTS')?.id).toBe(id('Clients'));
    expect(findFolderByPath(document.folders, 'Work\\Clients')?.id).toBe(id('Clients'));
  });

  it('refuses to build a path from a broken chain rather than returning a partial one', () => {
    // A/B/C with B missing is not A/C, and emitting that would file an import under a
    // folder nobody created.
    const folders: readonly Folder[] = [
      { id: 'a', name: 'A', parentId: null, order: 0 },
      { id: 'c', name: 'C', parentId: 'gone', order: 0 },
    ];
    expect(walkAncestors(folders, 'c').stoppedAt).toBe('missing-parent');
    expect(folderPath(folders, 'c')).toBeNull();
  });

  it('does not hang on a cyclic chain', () => {
    const folders: readonly Folder[] = [
      { id: 'a', name: 'A', parentId: 'b', order: 0 },
      { id: 'b', name: 'B', parentId: 'a', order: 0 },
    ];
    expect(walkAncestors(folders, 'a').stoppedAt).toBe('cycle');
    expect(folderPath(folders, 'a')).toBeNull();
    expect(subtreeHeight(folders, 'a')).toBe(2);
  });
});

describe('findOrCreateFolderPath', () => {
  it('creates every missing ancestor, in order, on an empty tree', () => {
    const result = findOrCreateFolderPath(emptyVaultDocument(), 'Work/Clients/Acme', context());

    expect(folderPath(result.document.folders, result.folder?.id ?? '')).toBe('Work/Clients/Acme');
    expect(result.document.folders).toHaveLength(3);
    expect(names(result.document, null)).toEqual(['Work']);
  });

  it('reuses what exists and creates only the missing tail', () => {
    const { document, id } = tree(['Work/Clients']);
    const result = findOrCreateFolderPath(document, 'Work/Clients/Acme', context());

    expect(result.document.folders).toHaveLength(3);
    expect(result.folder?.parentId).toBe(id('Clients'));
    expect(childrenOf(result.document.folders, null).map((f) => f.id)).toEqual([id('Work')]);
  });

  it('creates nothing at all for a path that already exists exactly', () => {
    const { document, id } = tree(['Work/Clients']);
    const result = findOrCreateFolderPath(document, 'Work/Clients', context());

    // Identity, not just equality: nothing was rebuilt, so an undo stack sees no change.
    expect(result.document).toBe(document);
    expect(result.folder?.id).toBe(id('Clients'));
  });

  it('matches case-insensitively and keeps the vault’s own spelling', () => {
    // A vault with `Work` and an export with `work` mean the same folder — and silently
    // recasing a folder the user named is an edit they did not ask for.
    const { document, id } = tree(['Work']);
    const result = findOrCreateFolderPath(document, 'WORK/clients', context());

    expect(result.document.folders).toHaveLength(2);
    expect(result.document.folders.find((folder) => folder.id === id('Work'))?.name).toBe('Work');
    expect(result.folder?.name).toBe('clients');
  });

  it('is idempotent — running the same import twice does not double the tree', () => {
    const once = findOrCreateFolderPath(emptyVaultDocument(), 'A/B/C', context());
    const twice = findOrCreateFolderPath(once.document, 'A/B/C', context());

    expect(twice.document).toBe(once.document);
    expect(twice.document.folders).toHaveLength(3);
  });

  it('returns no folder for a path that names nothing, and changes nothing', () => {
    const document = emptyVaultDocument();
    for (const path of ['', '   ', '/', '//', '\\']) {
      const result = findOrCreateFolderPath(document, path, context());
      expect(result.folder).toBeNull();
      expect(result.document).toBe(document);
    }
  });

  it('normalises the separator the source used', () => {
    const result = findOrCreateFolderPath(emptyVaultDocument(), 'Work\\Clients', context());
    expect(folderPath(result.document.folders, result.folder?.id ?? '')).toBe('Work/Clients');
  });

  it('drops empty segments rather than creating a folder called nothing', () => {
    const result = findOrCreateFolderPath(emptyVaultDocument(), 'A//B/  /C', context());
    expect(result.document.folders.map((folder) => folder.name)).toEqual(['A', 'B', 'C']);
  });

  it('refuses a path deeper than the limit before creating any of it', () => {
    const document = emptyVaultDocument();
    const path = Array.from({ length: MAX_FOLDER_DEPTH + 1 }, (_, i) => `L${i}`).join('/');
    expect(() => findOrCreateFolderPath(document, path, context())).toThrow(
      expect.objectContaining({ code: 'FOLDER_TOO_DEEP' })
    );
  });

  it('numbers the folders it creates contiguously', () => {
    const result = findOrCreateFolderPaths(
      emptyVaultDocument(),
      ['Work/C', 'Work/A', 'Work/B'],
      context()
    );
    expect(orders(result.document, null)).toEqual([0]);
    expect(names(result.document, result.folderIdByPath.get('Work') ?? '')).toEqual([
      'A',
      'B',
      'C',
    ]);
  });
});

describe('findOrCreateFolderPaths', () => {
  it('creates a shared ancestor once and maps every path, ancestors included', () => {
    const result = findOrCreateFolderPaths(
      emptyVaultDocument(),
      ['Work/Clients', 'Work/Suppliers', 'Work/Clients'],
      context()
    );

    expect(result.document.folders).toHaveLength(3);
    expect([...result.folderIdByPath.keys()].sort()).toEqual([
      'Work',
      'Work/Clients',
      'Work/Suppliers',
    ]);
    for (const [path, id] of result.folderIdByPath) {
      expect(folderPath(result.document.folders, id)).toBe(path);
    }
  });

  it('ignores paths that name nothing', () => {
    const result = findOrCreateFolderPaths(emptyVaultDocument(), ['', '  ', 'A'], context());
    expect(result.document.folders).toHaveLength(1);
    expect([...result.folderIdByPath.keys()]).toEqual(['A']);
  });

  it('produces the same tree regardless of the order the paths arrive in', () => {
    const forward = findOrCreateFolderPaths(emptyVaultDocument(), ['B/Y', 'A/X', 'A/Z'], context());
    const backward = findOrCreateFolderPaths(
      emptyVaultDocument(),
      ['A/Z', 'B/Y', 'A/X'],
      context()
    );

    const shape = (document: VaultDocument): readonly string[] =>
      [...document.folders].map((folder) => folderPath(document.folders, folder.id) ?? '').sort();
    expect(shape(forward.document)).toEqual(shape(backward.document));
    expect([...forward.folderIdByPath.keys()].sort()).toEqual(
      [...backward.folderIdByPath.keys()].sort()
    );
  });

  it('is the operation the import commit stage needs — placeholders resolve to real ids', () => {
    // What an importer emits: `import-folder:<path>` on the record, and the path list beside
    // it. The commit stage creates the folders here and rewrites the ids from this map.
    const paths = ['Work/Clients', 'Personal'];
    const result = findOrCreateFolderPaths(emptyVaultDocument(), paths, context());

    for (const path of paths) {
      const placeholder = importFolderId(path);
      const resolved = result.folderIdByPath.get(placeholder.slice('import-folder:'.length));
      expect(resolved).toBeDefined();
      expect(folderPath(result.document.folders, resolved ?? '')).toBe(path);
    }
  });
});

describe('order normalisation', () => {
  it('collapses gaps and duplicate order values to a dense 0..n-1', () => {
    const folders: readonly Folder[] = [
      { id: 'a', name: 'A', parentId: null, order: 7 },
      { id: 'b', name: 'B', parentId: null, order: 7 },
      { id: 'c', name: 'C', parentId: null, order: 99 },
    ];
    expect(normaliseFolderOrder(folders).map((folder) => folder.order)).toEqual([0, 1, 2]);
  });

  it('renumbers orphans among themselves without repairing the dangling parent', () => {
    // Ordering is normalised; the missing parent stays visible to the integrity report.
    const folders: readonly Folder[] = [
      { id: 'a', name: 'A', parentId: 'gone', order: 5 },
      { id: 'b', name: 'B', parentId: 'gone', order: 9 },
    ];
    const normalised = normaliseFolderOrder(folders);
    expect(normalised.map((folder) => folder.order)).toEqual([0, 1]);
    expect(normalised.every((folder) => folder.parentId === 'gone')).toBe(true);
  });

  it('runs on every write, so a tree that arrived with gaps is dense after one touch', () => {
    const document: VaultDocument = {
      ...emptyVaultDocument(),
      folders: [
        { id: 'a', name: 'A', parentId: null, order: 4 },
        { id: 'b', name: 'B', parentId: null, order: 40 },
      ],
    };
    const after = renameFolder(document, 'a', 'Alpha');
    expect(orders(after, null)).toEqual([0, 1]);
  });
});
