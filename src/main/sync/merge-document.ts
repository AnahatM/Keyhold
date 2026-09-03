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
  assertUniqueIds(base, ours, theirs);

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

/**
 * Safe only because `assertUniqueIds` ran first.
 *
 * `new Map` keeps the last entry for a repeated key, so on a document with two records sharing
 * an id this quietly discards one of them before the merge has looked at either. The guard at
 * the top of `mergeDocuments` is what makes that unreachable, and this comment is here so the
 * next reader does not have to reconstruct that argument from the call site.
 */
function indexRecords(records: readonly Credential[]): Map<string, Credential> {
  return new Map(records.map((record) => [record.id, record]));
}

// ── Duplicate ids ────────────────────────────────────────────────────────────

/** Which document a refusal is about, so a caller can name the file the user must repair. */
export type DocumentSide = 'ours' | 'theirs' | 'base';

/** Which list inside it. Matches the vocabulary `document-diagnosis.ts` reports in. */
export type DuplicatedEntity = 'record' | 'folder' | 'tag';

/**
 * A merge refused because one of the three documents holds two entries under one id.
 *
 * A named error rather than a bare one because the caller has a *specific* thing to do about
 * it — run `diagnose()` against the side named here, repair it, merge again — and asking a UI
 * to pattern-match prose to work that out is how a dialog ends up saying "merge failed". The
 * fields carry everything a message needs: which file, which list, and which ids. Nothing here
 * is secret material; a record id is already what `MergeNote.targetId` and the
 * `duplicate-record-id` diagnostic carry, and no title, password or note body goes near it.
 */
export class DuplicateIdError extends Error {
  readonly side: DocumentSide;
  readonly entity: DuplicatedEntity;
  readonly ids: readonly string[];

  constructor(side: DocumentSide, entity: DuplicatedEntity, ids: readonly string[]) {
    super(
      `Refusing to merge: the ${SIDE_NAMES[side]} vault has ${entity}s sharing an id (${ids.join(', ')}). Run a diagnosis on it and repair the duplicates first.`
    );
    this.name = 'DuplicateIdError';
    this.side = side;
    this.entity = entity;
    this.ids = ids;
  }
}

const SIDE_NAMES: Readonly<Record<DocumentSide, string>> = {
  ours: 'current',
  theirs: 'incoming',
  base: 'stored base snapshot of the',
};

/**
 * Refuses a merge whose input holds the same id twice, before anything reads it.
 *
 * **What a duplicate id means, and why refusing is the answer.** Two entries under one id is
 * corruption: identity is what every part of this engine merges *by*, so the input does not
 * describe a state the model can represent. There are only three honest responses, and two of
 * them cost the user something this one does not.
 *
 *  - **Keep one and report the other.** That is a lost credential with a note attached, and a
 *    note is not a password. Hard rule 6 does not have a "but we said so" clause.
 *  - **Keep both under fresh ids.** Minting an id needs a CSPRNG, which makes this engine
 *    impure and its output unreproducible between the resolver loop's passes; and the new id
 *    is a *new record* to the other device, so the duplicate propagates rather than resolving.
 *    It also severs the record from its ancestor, its history and its attachment chunks —
 *    repairing corruption by manufacturing more of it.
 *  - **Refuse.** Costs nothing. This engine is pure and writes no file, so a refusal leaves
 *    both vaults exactly as they were, on disk, with every record still in them. The user has
 *    a repair path already: `document-diagnosis.ts` emits `duplicate-record-id` for precisely
 *    this state, which means the codebase's answer to "what do I do about it" predates this
 *    guard and is not merging.
 *
 * So: refuse, loudly, naming the side and the ids — the same shape as
 * `assertSameDocumentVersion`, and for the same reason. A merge is the one operation that
 * reads two meanings of a thing at once and writes a single answer, and doing that when the
 * thing has two meanings *on one side* is how a vault loses a password.
 *
 * Records, folders and tags all need it. Custom fields, security questions and attachments do
 * not: `assertValidCredential` already refuses a record with duplicate ids in those lists, and
 * a second copy of that rule here would be the duplicate list hard rule 8 forbids.
 */
function assertUniqueIds(
  base: VaultDocument | null,
  ours: VaultDocument,
  theirs: VaultDocument
): void {
  // Ours first, then theirs, then the ancestor: the order the user can act on. A duplicate in
  // our own file is something they can repair now; one in the base snapshot is the least
  // alarming of the three and should not be the message they see when their own vault is the
  // one that needs work.
  assertUniqueSide(ours, 'ours');
  assertUniqueSide(theirs, 'theirs');
  if (base !== null) assertUniqueSide(base, 'base');
}

function assertUniqueSide(document: VaultDocument, side: DocumentSide): void {
  assertUniqueEntities(document.records, side, 'record');
  assertUniqueEntities(document.folders, side, 'folder');
  assertUniqueEntities(document.tags, side, 'tag');
}

function assertUniqueEntities(
  entries: readonly { readonly id: string }[],
  side: DocumentSide,
  entity: DuplicatedEntity
): void {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) repeated.add(entry.id);
    seen.add(entry.id);
  }
  // Every offending id, sorted: a caller listing them for the user should not have to guess
  // whether the report was truncated, and a corrupt vault with many duplicates is exactly the
  // one where a partial list would send someone round the repair loop twice.
  if (repeated.size > 0) throw new DuplicateIdError(side, entity, [...repeated].sort());
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
