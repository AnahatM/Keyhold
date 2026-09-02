// SPDX-License-Identifier: GPL-3.0-or-later
import { isImportFolderId } from '@shared/model/import.js';
import type { VaultDocument } from '@shared/model/vault-document.js';
import { childrenOf, walkAncestors } from './folder-tree.js';
import { tagKey } from './tag-ops.js';

/**
 * Structural checks on a vault's organisation, reported and **never repaired**.
 *
 * Every state below is real after a merge, a partial restore, an interrupted import, or a
 * hand-edited export — not hypothetical, and not the product of a bug in this module. A
 * record can point at a folder that another device deleted. A folder can point at a parent
 * that never arrived. Two folders can each end up the other's parent.
 *
 * ## Why nothing here fixes anything
 *
 * The repair is easy and that is the trap. Reparenting an orphan to the root, or clearing a
 * dangling `folderId`, takes one line — and destroys the only evidence of which of the three
 * causes produced it. "This record's folder is missing" is a merge that dropped a folder, a
 * restore from a backup written before the folder existed, or an import that committed
 * records before their folders; the three want three different responses, and after a silent
 * repair they are indistinguishable. So this reports, the UI offers, and the user chooses —
 * which is also the only way an undo can mean anything.
 *
 * The one thing a caller may safely conclude from a clean report is that the folder walks in
 * `folder-tree.ts` will terminate for a reason other than their cycle guards.
 *
 * ## Messages carry no content
 *
 * The same rule as `ImportWarning`: a message is shown on screen, written to a report, and
 * pasted into bug reports. These name **ids and counts only**. Names — a folder's, a tag's —
 * are the finding itself for the duplicate checks, so they travel in a dedicated `name`
 * field the caller can choose to render, never interpolated into the message text.
 * `integrity.test.ts` asserts that no message contains any name or title from its fixture.
 */

export const ORGANISATION_ISSUE_KINDS = [
  /** A record's `folderId` names no folder. The record is filed nowhere and shows nowhere. */
  'record-missing-folder',
  /** A folder's `parentId` names no folder. The subtree is unreachable from any root. */
  'folder-missing-parent',
  /** Folders form a loop. Unreachable from any root, and it hangs any walk without a guard. */
  'folder-cycle',
  /** A record carries a tag name with no `Tag` entry: no colour, no sidebar row. */
  'record-missing-tag',
  /** Two folders under one parent share a name. Allowed, but their paths are ambiguous. */
  'duplicate-folder-name',
  /** Two `Tag` entries fold to one name. Two rows, two colours, one set of records. */
  'duplicate-tag-name',
  /** An `import-folder:` placeholder reached the vault — a commit stage that did not finish. */
  'import-placeholder-folder',
] as const;

export type OrganisationIssueKind = (typeof ORGANISATION_ISSUE_KINDS)[number];

export interface OrganisationIssue {
  readonly kind: OrganisationIssueKind;
  /** Plain, content-free. What is wrong and what it means, never what anything is called. */
  readonly message: string;
  readonly folderIds?: readonly string[];
  readonly recordIds?: readonly string[];
  readonly tagIds?: readonly string[];
  /** The colliding name, for the duplicate checks only — where the name *is* the finding. */
  readonly name?: string;
}

/**
 * Builds an issue, omitting absent keys rather than setting them to `undefined`.
 *
 * `exactOptionalPropertyTypes` is on, so `{ name: undefined }` is not assignable to
 * `{ name?: string }`. The same shape `importWarning` uses, for the same reason.
 */
function issue(
  kind: OrganisationIssueKind,
  message: string,
  where: {
    readonly folderIds?: readonly string[] | undefined;
    readonly recordIds?: readonly string[] | undefined;
    readonly tagIds?: readonly string[] | undefined;
    readonly name?: string | undefined;
  } = {}
): OrganisationIssue {
  return {
    kind,
    message,
    ...(where.folderIds === undefined ? {} : { folderIds: where.folderIds }),
    ...(where.recordIds === undefined ? {} : { recordIds: where.recordIds }),
    ...(where.tagIds === undefined ? {} : { tagIds: where.tagIds }),
    ...(where.name === undefined ? {} : { name: where.name }),
  };
}

/** Records whose `folderId` names no folder, grouped by the missing id. */
function checkRecordFolders(document: VaultDocument): readonly OrganisationIssue[] {
  const known = new Set(document.folders.map((folder) => folder.id));
  const byMissingFolder = new Map<string, string[]>();

  for (const record of document.records) {
    const folderId = record.folderId;
    if (folderId === null || known.has(folderId)) continue;
    // Reported by its own check, with a far more specific cause. Counting it here as well
    // would make one bug look like two.
    if (isImportFolderId(folderId)) continue;

    const affected = byMissingFolder.get(folderId);
    if (affected === undefined) byMissingFolder.set(folderId, [record.id]);
    else affected.push(record.id);
  }

  return [...byMissingFolder].map(([folderId, recordIds]) =>
    issue(
      'record-missing-folder',
      `${recordIds.length} record(s) are filed under a folder that no longer exists.`,
      { folderIds: [folderId], recordIds }
    )
  );
}

/** Records still carrying an `import-folder:` placeholder — an import that never committed. */
function checkImportPlaceholders(document: VaultDocument): readonly OrganisationIssue[] {
  const byPlaceholder = new Map<string, string[]>();

  for (const record of document.records) {
    const folderId = record.folderId;
    if (folderId === null || !isImportFolderId(folderId)) continue;

    const affected = byPlaceholder.get(folderId);
    if (affected === undefined) byPlaceholder.set(folderId, [record.id]);
    else affected.push(record.id);
  }

  return [...byPlaceholder].map(([folderId, recordIds]) =>
    issue(
      'import-placeholder-folder',
      `${recordIds.length} record(s) still hold an unresolved import placeholder instead of a folder. An import was committed without creating its folders.`,
      { folderIds: [folderId], recordIds }
    )
  );
}

/**
 * Folders with a missing parent, and folders caught in a loop.
 *
 * Both come from the same walk, because they are the same question asked of every folder:
 * does the chain above it reach a root? A cycle is reported once per distinct loop rather
 * than once per member — the loop is the finding — and is canonicalised by its sorted member
 * ids so the same cycle reached from two different folders is one entry.
 */
function checkFolderParents(document: VaultDocument): readonly OrganisationIssue[] {
  const issues: OrganisationIssue[] = [];
  const known = new Set(document.folders.map((folder) => folder.id));
  const reportedCycles = new Set<string>();

  for (const folder of document.folders) {
    if (folder.parentId !== null && !known.has(folder.parentId)) {
      issues.push(
        issue(
          'folder-missing-parent',
          'A folder names a parent that no longer exists, so it and everything under it is unreachable from the sidebar.',
          { folderIds: [folder.id] }
        )
      );
      continue;
    }

    const walk = walkAncestors(document.folders, folder.id);
    if (walk.stoppedAt !== 'cycle') continue;

    // The loop is the ancestors the walk collected plus the folder itself. Sorting makes the
    // key independent of where the walk started.
    const members = [...new Set([folder.id, ...walk.ids])].sort();
    const key = members.join(',');
    if (reportedCycles.has(key)) continue;
    reportedCycles.add(key);

    issues.push(
      issue(
        'folder-cycle',
        `${members.length} folders form a loop, so none of them is reachable from any root.`,
        { folderIds: members }
      )
    );
  }
  return issues;
}

/** Tag names on records with no `Tag` entry behind them. */
function checkRecordTags(document: VaultDocument): readonly OrganisationIssue[] {
  const declared = new Set(document.tags.map((tag) => tagKey(tag.name)));
  const byMissingTag = new Map<string, string[]>();

  for (const record of document.records) {
    for (const name of record.tags) {
      const key = tagKey(name);
      if (declared.has(key)) continue;

      const affected = byMissingTag.get(key);
      if (affected === undefined) byMissingTag.set(key, [record.id]);
      else affected.push(record.id);
    }
  }

  return [...byMissingTag].map(([key, recordIds]) =>
    issue(
      'record-missing-tag',
      `${recordIds.length} record(s) carry a tag the vault does not declare, so it has no colour and no place in the sidebar.`,
      { recordIds, name: key }
    )
  );
}

/** Siblings sharing a name — permitted, but it makes their paths ambiguous. */
function checkDuplicateFolderNames(document: VaultDocument): readonly OrganisationIssue[] {
  const issues: OrganisationIssue[] = [];
  const parents = new Set<string | null>(document.folders.map((folder) => folder.parentId));

  for (const parentId of parents) {
    const byName = new Map<string, { readonly name: string; readonly ids: string[] }>();
    for (const folder of childrenOf(document.folders, parentId)) {
      const key = folder.name.toLowerCase();
      const group = byName.get(key);
      if (group === undefined) byName.set(key, { name: folder.name, ids: [folder.id] });
      else group.ids.push(folder.id);
    }

    for (const group of byName.values()) {
      if (group.ids.length < 2) continue;
      issues.push(
        issue(
          'duplicate-folder-name',
          `${group.ids.length} folders under the same parent share a name, so a path naming it is ambiguous.`,
          { folderIds: group.ids, name: group.name }
        )
      );
    }
  }
  return issues;
}

/**
 * Two `Tag` entries that fold to the same name.
 *
 * `createTag` cannot produce this, and it is here because a merge of two vaults trivially
 * can: each device created `Work` independently, with its own id and its own colour, and
 * neither is wrong. Records name one string, so both entries claim all of them.
 */
function checkDuplicateTagNames(document: VaultDocument): readonly OrganisationIssue[] {
  const byName = new Map<string, { readonly name: string; readonly ids: string[] }>();
  for (const tag of document.tags) {
    const key = tagKey(tag.name);
    const group = byName.get(key);
    if (group === undefined) byName.set(key, { name: tag.name, ids: [tag.id] });
    else group.ids.push(tag.id);
  }

  const issues: OrganisationIssue[] = [];
  for (const group of byName.values()) {
    if (group.ids.length < 2) continue;
    issues.push(
      issue(
        'duplicate-tag-name',
        `${group.ids.length} tags share a name, so they claim the same records and only one of their colours can win.`,
        { tagIds: group.ids, name: group.name }
      )
    );
  }
  return issues;
}

/**
 * Every organisation problem in the document, in a stable order.
 *
 * Stable so that two runs over an unchanged vault produce an identical report — which is
 * what makes it comparable before and after a merge, and what stops a UI list reshuffling
 * itself between renders.
 */
export function checkOrganisation(document: VaultDocument): readonly OrganisationIssue[] {
  return [
    ...checkFolderParents(document),
    ...checkRecordFolders(document),
    ...checkImportPlaceholders(document),
    ...checkRecordTags(document),
    ...checkDuplicateFolderNames(document),
    ...checkDuplicateTagNames(document),
  ];
}

/** True when nothing above fired. The cheap question a save path or a merge wants to ask. */
export function isOrganisationSound(document: VaultDocument): boolean {
  return checkOrganisation(document).length === 0;
}
