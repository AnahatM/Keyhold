// SPDX-License-Identifier: GPL-3.0-or-later
import type { VaultDocument } from '@shared/model/vault-document.js';
import { deleteFolder, findFolderIn } from '../organisation/folder-ops.js';
import { folderPathsById } from '../organisation/folder-tree.js';
import { deleteTag, findTag } from '../organisation/tag-ops.js';
import { findCredential, purgeCredential, replaceCredential } from '../vault/credential-ops.js';
import type { ImportBatchRecord } from './commit.js';

/**
 * Taking an import back.
 *
 * ## Why this exists at all
 *
 * An import that cannot be undone is one people are afraid to run, and a password manager
 * whose migration step is frightening is a password manager nobody migrates to. The offer
 * has to be real, though — an "undo" that half-works, or that removes a record the user
 * edited in the meantime, is worse than no offer, because they will have believed it.
 *
 * ## The guard is the design
 *
 * Undo removes records **by id**. That description is only safe while the vault is in
 * exactly the state the commit left it in; the moment anything else has written, "remove
 * what the import added" stops being a statement about the user's data and becomes a guess.
 * So the caller checks the save generation *and* that nothing is sitting unsaved before it
 * gets here (see `import-service.ts`), and refuses rather than guessing.
 *
 * That guard is what licenses the two otherwise-alarming things this module does:
 * **`purgeCredential`, not `trashCredential`** — an imported record was never the user's
 * data, and leaving three thousand of them in the Trash to be found later is not undoing
 * anything — and **restoring a merged record wholesale from a snapshot**, which would
 * clobber a concurrent edit if a concurrent edit were possible.
 *
 * ## It is still defensive
 *
 * Every removal is checked before it happens: a created folder that somehow holds a record
 * or a child folder is left standing and left out of the result, and a created tag still
 * carried by a record is kept. The guard should make all three impossible. "Should" is not
 * the standard for the code path whose entire job is not losing data.
 */

export interface UndoImportOutcome {
  readonly document: VaultDocument;
  /** Imported records removed. */
  readonly removedCount: number;
  /** Merged records put back to their pre-merge state. */
  readonly restoredCount: number;
  readonly removedFolderPaths: readonly string[];
}

export function undoImport(document: VaultDocument, batch: ImportBatchRecord): UndoImportOutcome {
  let current = document;
  let removedCount = 0;

  for (const recordId of batch.createdRecordIds) {
    if (findCredential(current, recordId) === null) continue;
    current = purgeCredential(current, recordId);
    removedCount += 1;
  }

  let restoredCount = 0;
  for (const snapshot of batch.mergedSecretSnapshots) {
    // Only put back a record that is still there. A merged record the user has since deleted
    // outright is theirs to have deleted, and resurrecting it would be this module inventing
    // a record rather than un-inventing one.
    if (findCredential(current, snapshot.id) === null) continue;
    current = replaceCredential(current, snapshot);
    restoredCount += 1;
  }

  const removedFolderPaths: string[] = [];
  for (const folderId of batch.createdFolderIds) {
    // Paths are read from the document as it stands at this moment, because removing a
    // deeper folder first cannot change a shallower one's path but reading them all up front
    // would go stale if that ever stopped being true.
    const path = folderPathsById(current.folders).get(folderId);
    if (findFolderIn(current, folderId) === null) continue;
    if (!isFolderEmpty(current, folderId)) continue;

    // `unfile` rather than `reparent`, though the folder is verified empty and the two are
    // therefore equivalent here: `unfile` says "this folder and its subtree are going", which
    // is what undo means, and would not quietly re-home a child if the emptiness check above
    // were ever weakened.
    current = deleteFolder(current, folderId, 'unfile');
    if (path !== undefined) removedFolderPaths.push(path);
  }

  for (const tagId of batch.createdTagIds) {
    const tag = findTag(current, tagId);
    if (tag === null) continue;
    const key = tag.name.toLowerCase();
    if (current.records.some((record) => record.tags.some((name) => name.toLowerCase() === key))) {
      continue;
    }
    current = deleteTag(current, tagId).document;
  }

  return {
    document: current,
    removedCount,
    restoredCount,
    removedFolderPaths: removedFolderPaths.sort(),
  };
}

/** No records filed here, and no child folders. Both, because either would be data to lose. */
function isFolderEmpty(document: VaultDocument, folderId: string): boolean {
  return (
    !document.records.some((record) => record.folderId === folderId) &&
    !document.folders.some((folder) => folder.parentId === folderId)
  );
}
