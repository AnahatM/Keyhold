// SPDX-License-Identifier: GPL-3.0-or-later
import type { ChangeOrigin, Credential } from '@shared/model/credential.js';
import type {
  ConflictChoice,
  MergeConflict,
  MergeNote,
  MergeRecordCounts,
  MergeReport,
} from '@shared/model/sync.js';
import type { Folder, VaultDocument } from '@shared/model/vault-document.js';
import {
  mergeFolders,
  mergeSettings,
  mergeTagPalette,
  repairFolderTree,
} from './merge-collections.js';
import { mergeCredential } from './merge-record.js';
import { orderIds } from './merge-values.js';
import { sameValue } from './stable-value.js';

/**
 * The merge engine's front door: two decrypted vault documents in, one merged document and a
 * report out.
 *
 * **Pure.** No file, no key, no clock this function was not handed. The caller decrypts both
 * sides, takes the mandatory pre-merge backup, calls this, shows the report, and writes only
 * when the report says it may. Keeping the engine free of I/O is what lets the whole conflict
 * matrix be tested directly rather than through two unlocked vaults on two machines — which,
 * for a problem whose failure mode is a silently lost password, is not a nicety.
 *
 * ## Three-way where possible, two-way where not, and never a pretence about which
 *
 * `base` is the last state both devices agreed on — the stored base snapshot. With it, "one
 * side changed this and the other did not" is answerable, and most of a real merge answers
 * itself. Without it, the only knowable fact is that two values differ, and this engine says
 * so rather than guessing: every difference becomes a conflict, and nothing is deleted on the
 * evidence of absence.
 *
 * ## The rule that outranks the others: absence is not deletion
 *
 * A record in the ancestor and on one side only has two possible explanations — the other
 * device purged it, or the other device's copy is incomplete. This engine **keeps it**, and
 * reports `record-kept-unmatched`.
 *
 * That trade is deliberate and it is not free. Its cost is that a genuine purge — which is
 * only reachable after a record has sat in the Trash past its retention window — can come
 * back once, and the user has to purge it again. Its benefit is that no truncated file, no
 * half-synced cloud folder and no restored-from-an-old-backup device can ever cause a
 * credential to vanish. Set against goal G1, *never lose a credential*, that is not a close
 * call. Deletion has a marker for exactly this reason: `trashedAt` is a tombstone, and a
 * tombstone is honoured. Absence is not a tombstone.
 *
 * ## What this engine does not do
 *
 * It merges **documents**, not containers. Attachment *bytes* live in the KEEP container as
 * separate encrypted chunks, and a merged record can reference a chunk that only the other
 * file holds. Those ids come back in `report.attachmentsToImport`, and the caller must copy
 * them across before writing, or those records will point at attachments that cannot be
 * opened. The report says so rather than the engine silently dropping the reference, because
 * dropping it would lose the attachment permanently.
 */

export interface MergeOptions {
  /**
   * The caller's clock, used for `report.generatedAt` and nothing else.
   *
   * Deliberately not used to stamp merged records: a merge is not an edit of every record it
   * touched, and marking a whole vault as modified-now would make the change invisible in the
   * one column anyone would look at. See `mergeMeta` in `merge-record.ts`.
   */
  readonly now: number;
  /**
   * Provenance for the version that records the merge on each record it changed.
   *
   * Omit it and no merge versions are written — the setting behind hard rule 7, so a user who
   * would rather their timeline not fill with merge entries can say so. `action` should be
   * `'merge'`; `HistoryAction` has carried the verb since the model was written.
   */
  readonly mergeOrigin?: ChangeOrigin | undefined;
  /**
   * Answers to conflicts from a previous run, keyed by `MergeConflict.id`.
   *
   * The resolver loop is: merge, show the conflicts, collect choices, **merge again** with
   * them folded in. One implementation, no separate "apply resolutions" path that could
   * diverge from it, and no need for a conflict's actual values to have ever crossed to the
   * renderer.
   */
  readonly resolutions?: Readonly<Record<string, ConflictChoice>> | undefined;
}

export interface MergeOutcome {
  /**
   * The merged document.
   *
   * **Provisional while `report.requiresResolution` is true.** Every unresolved conflict has a
   * value in here so the document is complete and renderable; committing it unasked would be
   * exactly the last-writer-wins behaviour this engine exists to prevent.
   */
  readonly document: VaultDocument;
  readonly report: MergeReport;
}

export function mergeDocuments(
  base: VaultDocument | null,
  ours: VaultDocument,
  theirs: VaultDocument,
  options: MergeOptions
): MergeOutcome {
  assertSameDocumentVersion(base, ours, theirs);

  const resolutions = new Map<string, ConflictChoice>(Object.entries(options.resolutions ?? {}));
  const recordContext = {
    ancestorKnown: base !== null,
    mergeOrigin: options.mergeOrigin ?? null,
    resolutions,
  };

  const conflicts: MergeConflict[] = [];
  const notes: MergeNote[] = [];
  const attachments = new Set<string>();

  // ── Records ────────────────────────────────────────────────────────────────
  const ourRecords = indexRecords(ours.records);
  const theirRecords = indexRecords(theirs.records);
  const baseRecords = base === null ? null : indexRecords(base.records);
  const ourChunks = chunkIds(ours.records);

  const surviving = new Map<string, Credential>();
  for (const id of new Set([
    ...(baseRecords?.keys() ?? []),
    ...ourRecords.keys(),
    ...theirRecords.keys(),
  ])) {
    const mine = ourRecords.get(id);
    const yours = theirRecords.get(id);
    const ancestor = baseRecords?.get(id);

    if (mine !== undefined && yours !== undefined) {
      // `ancestor ?? null` is not a shortcut. A record created independently on both sides —
      // two imports of the same export file, most plausibly — is in neither ancestor, and the
      // honest merge for it is two-way *for that record only*, inside a three-way document
      // merge. Passing the document's base here would be claiming an ancestor it does not have.
      const merged = mergeCredential(ancestor ?? null, mine, yours, recordContext);
      surviving.set(id, merged.credential);
      conflicts.push(...merged.conflicts);
      notes.push(...merged.notes);
      for (const chunk of merged.attachmentsToImport) attachments.add(chunk);
      continue;
    }

    const present = mine ?? yours;
    if (present === undefined) {
      // In the ancestor, gone from both sides: both devices purged it, and they agree.
      notes.push({ kind: 'record-purged', targetId: id, count: null });
      continue;
    }

    surviving.set(id, present);
    if (ancestor !== undefined) {
      // Present in the ancestor and on one side only. See the header: absence is not deletion.
      notes.push({ kind: 'record-kept-unmatched', targetId: id, count: null });
      if (mine === undefined) collectAttachments(present, ourChunks, attachments);
    } else if (mine === undefined) {
      notes.push({ kind: 'record-added', targetId: id, count: null });
      collectAttachments(present, ourChunks, attachments);
    }
  }

  const recordOrder = orderIds(
    new Set(surviving.keys()),
    ours.records.map((record) => record.id),
    theirs.records.map((record) => record.id),
    base === null ? null : base.records.map((record) => record.id)
  );
  const mergedRecords = recordOrder
    .map((id) => surviving.get(id))
    .filter((record): record is Credential => record !== undefined);

  // ── Folders, the tag palette and settings ──────────────────────────────────
  const folders = mergeFolders(base?.folders ?? null, ours.folders, theirs.folders, resolutions);
  const palette = mergeTagPalette(base?.tags ?? null, ours.tags, theirs.tags, resolutions);
  const settings = mergeSettings(
    base?.settings ?? null,
    ours.settings,
    theirs.settings,
    resolutions
  );
  conflicts.push(...folders.conflicts, ...palette.conflicts, ...settings.conflicts);
  notes.push(...folders.notes, ...palette.notes);

  const repaired = repairFolderTree(folders.items, mergedRecords, folderPool(base, ours, theirs));
  notes.push(...repaired.notes);

  const document: VaultDocument = {
    documentVersion: ours.documentVersion,
    records: repaired.records,
    folders: repaired.folders,
    tags: palette.items,
    settings: settings.settings,
  };

  return {
    document,
    report: {
      mode: base === null ? 'two-way' : 'three-way',
      generatedAt: options.now,
      counts: countRecords(base, ours, theirs, document, conflicts),
      conflicts,
      notes,
      requiresResolution: conflicts.some((conflict) => conflict.resolution === 'unresolved'),
      // Filtered against the whole of our container, not just the record that asked. A chunk
      // is shared by id, so a record arriving from the other side may reference an attachment
      // some *other* record of ours already holds, and telling the caller to copy it again
      // would be busywork at best and a duplicate chunk at worst.
      attachmentsToImport: [...attachments].filter((id) => !ourChunks.has(id)).sort(),
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function indexRecords(records: readonly Credential[]): Map<string, Credential> {
  return new Map(records.map((record) => [record.id, record]));
}

/**
 * Merging documents written against different schema versions is refused, not attempted.
 *
 * A migration exists precisely because the meaning of a field changed, and a merge is the one
 * operation that reads both meanings at once and writes a single answer. Doing that across a
 * version boundary is how a vault ends up holding a field that means neither thing. The caller
 * migrates both sides to the current version first; `migrateBody` already does exactly that.
 */
function assertSameDocumentVersion(
  base: VaultDocument | null,
  ours: VaultDocument,
  theirs: VaultDocument
): void {
  const versions = new Set([
    ours.documentVersion,
    theirs.documentVersion,
    ...(base === null ? [] : [base.documentVersion]),
  ]);
  if (versions.size > 1) {
    throw new Error(
      `Refusing to merge vaults written against different document versions (${[...versions].sort().join(', ')}). Migrate both to the current version first.`
    );
  }
}

function chunkIds(records: readonly Credential[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const record of records) {
    for (const attachment of record.attachments) ids.add(attachment.id);
  }
  return ids;
}

/** Chunks a record brings with it that our container does not already hold. */
function collectAttachments(
  record: Credential,
  held: ReadonlySet<string>,
  into: Set<string>
): void {
  for (const attachment of record.attachments) {
    if (!held.has(attachment.id)) into.add(attachment.id);
  }
}

/** Every folder either side has ever named, for `repairFolderTree` to resurrect from. */
function folderPool(
  base: VaultDocument | null,
  ours: VaultDocument,
  theirs: VaultDocument
): readonly Folder[] {
  return [...(base?.folders ?? []), ...theirs.folders, ...ours.folders];
}

function countRecords(
  base: VaultDocument | null,
  ours: VaultDocument,
  theirs: VaultDocument,
  merged: VaultDocument,
  conflicts: readonly MergeConflict[]
): MergeRecordCounts {
  const ourRecords = indexRecords(ours.records);
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let trashed = 0;

  for (const record of merged.records) {
    const mine = ourRecords.get(record.id);
    if (mine === undefined) added += 1;
    else if (sameValue(mine, record)) unchanged += 1;
    else updated += 1;
    if (record.trashedAt !== null) trashed += 1;
  }

  const conflicted = new Set(
    conflicts
      .filter((conflict) => conflict.kind.startsWith('record-'))
      .map((conflict) => conflict.targetId)
  );

  return {
    ours: ours.records.length,
    theirs: theirs.records.length,
    base: base === null ? null : base.records.length,
    merged: merged.records.length,
    added,
    updated,
    unchanged,
    trashed,
    conflicted: conflicted.size,
  };
}
