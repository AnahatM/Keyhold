// SPDX-License-Identifier: GPL-3.0-or-later
import type { Credential, CustomField } from '@shared/model/credential.js';
import {
  DEFAULT_DUPLICATE_ACTION,
  IMPORT_DUPLICATE_ACTIONS,
  type ImportDuplicateAction,
  type ImportDuplicateGroup,
} from '@shared/model/import-plan.js';
import { importWarning, normaliseFolderPath, type ImportWarning } from '@shared/model/import.js';
import type { VaultDocument } from '@shared/model/vault-document.js';
import { appendVersion } from '../history/versioning.js';
import { findOrCreateFolderPaths } from '../organisation/folder-ops.js';
import { folderPathsById } from '../organisation/folder-tree.js';
import { ensureTags } from '../organisation/tag-ops.js';
import {
  addCredential,
  applyPatch,
  buildCredential,
  findCredential,
  originFor,
  replaceCredential,
  type NewCredentialInput,
  type OpsContext,
} from '../vault/credential-ops.js';
import { planMerge } from './merge.js';
import { placeholderPathOf, type HeldImportPlan, type PlanProgress } from './plan.js';

/**
 * The write.
 *
 * ## Everything here goes through the operations that already own these rules
 *
 * A record is built by `buildCredential`, a folder by `findOrCreateFolderPaths`, a tag by
 * `ensureTags`, an edit by `applyPatch` + `appendVersion`. None of it is assembled here.
 * That is not tidiness — an import that constructed records itself would be a **second
 * definition of what a valid record is**, and the two would drift on the day someone adds a
 * field. The parsers produce `NewCredentialInput` for exactly this reason (see
 * `src/main/import/types.ts`), and this module is where that promise is kept.
 *
 * ## It is a pure function over a document
 *
 * Nothing here touches a key, a file, or a clock it did not receive, for the same reason
 * `credential-ops.ts` and `folder-ops.ts` do not: the rules about what an import does to a
 * vault are the part most likely to acquire a subtle bug, and keeping them free of I/O is
 * what lets every one of them be tested directly rather than through an unlocked vault. The
 * caller installs the returned document and saves it.
 *
 * ## Nothing is aborted over one bad row
 *
 * A record the vault refuses — a title past the length cap, thirty-three URLs — becomes a
 * warning and a skip, not an exception. Refusing a three-thousand-record export over one bad
 * row is how a user ends up retyping their vault by hand. The warning names the record's
 * *position* and nothing else: the reason a record was refused is built from the value that
 * broke the rule, and that value is a password as often as not.
 *
 * ## The counts add up
 *
 * `importedCount + skippedCount + mergedCount === plan.recordCount`, always. It is the one
 * arithmetic a user can check against the preview they approved, and the renderer's own
 * summary (`duplicate-decisions.ts`) predicts it independently — two calculations that a
 * test can hold against each other.
 */

/** What the commit created, so `undo` can remove precisely that and nothing else. */
export interface ImportBatchRecord {
  readonly createdRecordIds: readonly string[];
  /** Deepest first, so removing them in order never orphans a child. */
  readonly createdFolderIds: readonly string[];
  /** The same folders as paths, parents first, for the result the user reads. */
  readonly createdFolderPaths: readonly string[];
  readonly createdTagIds: readonly string[];
  /**
   * The vault records a merge touched, exactly as they were before it.
   *
   * Secret-bearing — a full `Credential`, password included — and named so. It is the only
   * way undo can put a merged record back: the merge overwrote fields, and "un-merging" by
   * reasoning backwards from the incoming values is guesswork the moment two rows fed the
   * same record.
   */
  readonly mergedSecretSnapshots: readonly Credential[];
}

export interface ImportCommitOutcome {
  readonly document: VaultDocument;
  readonly batch: ImportBatchRecord;
  /** Incoming records that became a new credential. */
  readonly importedCount: number;
  /** Incoming records deliberately not written, or that the vault refused. */
  readonly skippedCount: number;
  /** Incoming records folded into another record. */
  readonly mergedCount: number;
  /** Problems from the write itself, on top of the ones the preview already reported. */
  readonly warnings: readonly ImportWarning[];
}

export interface CommitImportInput {
  readonly document: VaultDocument;
  readonly plan: HeldImportPlan;
  readonly duplicateActions: Readonly<Record<string, ImportDuplicateAction>>;
  readonly extraTags: readonly string[];
  readonly ops: OpsContext;
  readonly onWriteProgress?: PlanProgress | undefined;
}

/**
 * What happens to one parsed record.
 *
 * `merge-into-created` exists because a duplicate group can be entirely *within the file* —
 * two rows of the same export, matching nothing in the vault. One of them has to become a
 * record under every decision, and the other rows then merge into that one rather than into
 * anything the vault already had.
 */
type RecordDecision =
  | { readonly kind: 'import' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'merge-existing'; readonly credentialId: string }
  | { readonly kind: 'merge-into-created'; readonly leadIndex: number };

export function commitImport(input: CommitImportInput): ImportCommitOutcome {
  const { plan, ops } = input;
  const warnings: ImportWarning[] = [];
  const decisions = decide(plan, input.duplicateActions);

  const foldersBefore = new Set(input.document.folders.map((folder) => folder.id));
  const tagsBefore = new Set(input.document.tags.map((tag) => tag.id));

  let document = createFolders(input.document, plan, decisions, ops);
  const folderIdByPath = folderIdsByPath(document);
  document = createTags(document, plan, decisions, input.extraTags, ops, warnings);

  const created = writeRecords({
    document,
    plan,
    decisions,
    extraTags: input.extraTags,
    folderIdByPath,
    ops,
    warnings,
    ...(input.onWriteProgress === undefined ? {} : { onWriteProgress: input.onWriteProgress }),
  });

  const merged = applyMerges({
    document: created.document,
    plan,
    decisions,
    createdByIndex: created.createdByIndex,
    createdRecordIds: new Set(created.createdRecordIds),
    folderIdByPath,
    ops,
    warnings,
  });

  const document_ = merged.document;
  const folders = describeNewFolders(document_, foldersBefore);

  return {
    document: document_,
    batch: {
      createdRecordIds: created.createdRecordIds,
      createdFolderIds: folders.idsDeepestFirst,
      createdFolderPaths: folders.paths,
      createdTagIds: document_.tags.filter((tag) => !tagsBefore.has(tag.id)).map((tag) => tag.id),
      mergedSecretSnapshots: merged.snapshots,
    },
    importedCount: created.importedCount,
    skippedCount: created.skippedCount + merged.skippedCount,
    mergedCount: merged.mergedCount,
    warnings,
  };
}

// ── Deciding ─────────────────────────────────────────────────────────────────

/**
 * Turns the user's per-group answers into a decision per record.
 *
 * A record in no group is new and is imported. A key absent from `duplicateActions`, or
 * carrying something that is not one of the three answers, takes
 * `DEFAULT_DUPLICATE_ACTION` — so a partial or malformed map from a compromised renderer
 * fails **safe**, changing nothing in the vault, rather than importing duplicates.
 */
function decide(
  plan: HeldImportPlan,
  duplicateActions: Readonly<Record<string, ImportDuplicateAction>>
): readonly RecordDecision[] {
  const decisions: RecordDecision[] = plan.secretRecords.map(() => ({ kind: 'import' }));

  for (const group of plan.duplicates) {
    const action = toDuplicateAction(duplicateActions[group.key]);
    const lead = group.incoming[0];
    if (lead === undefined) continue;

    for (const [position, projection] of group.incoming.entries()) {
      // The first row of a within-file cluster is a genuinely new record under every
      // decision; only the rows after it are the redundant copies the decision is about.
      const isLead = group.existing === null && position === 0;
      decisions[projection.index] = isLead
        ? { kind: 'import' }
        : decisionFor(action, group, lead.index);
    }
  }
  return decisions;
}

function decisionFor(
  action: ImportDuplicateAction,
  group: ImportDuplicateGroup,
  leadIndex: number
): RecordDecision {
  switch (action) {
    case 'skip':
      return { kind: 'skip' };
    case 'import-anyway':
      return { kind: 'import' };
    case 'merge':
      return group.existing === null
        ? { kind: 'merge-into-created', leadIndex }
        : { kind: 'merge-existing', credentialId: group.existing.credentialId };
  }
}

/** Narrows a value that arrived over IPC to one of the three answers, failing safe. */
export function toDuplicateAction(value: unknown): ImportDuplicateAction {
  return (IMPORT_DUPLICATE_ACTIONS as readonly string[]).includes(value as string)
    ? (value as ImportDuplicateAction)
    : DEFAULT_DUPLICATE_ACTION;
}

// ── Folders ──────────────────────────────────────────────────────────────────

/**
 * Creates the folders the import actually needs, and no others.
 *
 * "Actually needs" is narrower than "the file mentions". A folder whose every record the
 * user chose to skip would otherwise appear in their sidebar, empty, as the only trace of an
 * import they were told changed nothing.
 *
 * A record being *merged* contributes its folder only when the record it is merging into is
 * filed nowhere — which is the one case `planMerge` will actually spend it on, since a merge
 * fills an empty folder and never moves a record out of the one its owner chose.
 */
function createFolders(
  document: VaultDocument,
  plan: HeldImportPlan,
  decisions: readonly RecordDecision[],
  ops: OpsContext
): VaultDocument {
  const wanted: string[] = [];

  for (const [index, record] of plan.secretRecords.entries()) {
    const decision = decisions[index];
    if (decision === undefined || decision.kind === 'skip') continue;

    const path = placeholderPathOf(record);
    if (path === null) continue;

    if (decision.kind === 'merge-existing') {
      // A missing target reads as `undefined` here, which is not `null`, so it continues —
      // the same answer as a target that is already filed somewhere.
      if (findCredential(document, decision.credentialId)?.folderId !== null) continue;
    }
    if (decision.kind === 'merge-into-created') {
      const lead = plan.secretRecords[decision.leadIndex];
      if (lead === undefined || placeholderPathOf(lead) !== null) continue;
    }
    wanted.push(path);
  }

  // `findOrCreateFolderPaths` creates every missing ancestor in order, reuses what the vault
  // already has case-insensitively, and never rewrites an existing folder's spelling. All
  // three are properties an import needs and none of them is this module's to reimplement.
  return findOrCreateFolderPaths(document, wanted, ops).document;
}

/**
 * Path → folder id, **case-folded**.
 *
 * Folded because that is how folders resolve everywhere else in the codebase: a vault with
 * `Work` and an export with `work` mean the same folder, `findOrCreateFolderPath` reuses the
 * vault's, and a case-sensitive lookup here would then fail to find the folder that call
 * just settled and file the record at the root instead.
 */
function folderIdsByPath(document: VaultDocument): ReadonlyMap<string, string> {
  const byPath = new Map<string, string>();
  for (const [id, path] of folderPathsById(document.folders)) {
    const key = path.toLowerCase();
    // Lowest (order, id) wins, matching `findFolderByPath`, so a vault that already contains
    // duplicate siblings resolves the same way here as everywhere else.
    if (!byPath.has(key)) byPath.set(key, id);
  }
  return byPath;
}

function describeNewFolders(
  document: VaultDocument,
  before: ReadonlySet<string>
): { readonly idsDeepestFirst: readonly string[]; readonly paths: readonly string[] } {
  const pathById = folderPathsById(document.folders);
  const created = document.folders.filter((folder) => !before.has(folder.id));
  const depth = (id: string): number => (pathById.get(id) ?? '').split('/').length;

  return {
    idsDeepestFirst: [...created].sort((a, b) => depth(b.id) - depth(a.id)).map((f) => f.id),
    paths: created.map((folder) => pathById.get(folder.id) ?? folder.name).sort(),
  };
}

// ── Tags ─────────────────────────────────────────────────────────────────────

/**
 * Gives every tag the import uses a real entry, so it has a colour and a sidebar row.
 *
 * One name at a time, each in its own guard, rather than one `ensureTags` call over all of
 * them. `ensureTags` is all-or-nothing, and a single 120-character label out of somebody's
 * export would otherwise take the entire import down with it. The records still carry the
 * name either way — a tag with no entry is a cosmetic loss, and it is reported rather than
 * swallowed.
 */
function createTags(
  document: VaultDocument,
  plan: HeldImportPlan,
  decisions: readonly RecordDecision[],
  extraTags: readonly string[],
  ops: OpsContext,
  warnings: ImportWarning[]
): VaultDocument {
  const names = new Set<string>();
  for (const [index, record] of plan.secretRecords.entries()) {
    if (decisions[index]?.kind === 'skip') continue;
    for (const tag of record.tags ?? []) names.add(tag);
  }
  for (const tag of extraTags) names.add(tag);

  let current = document;
  let refused = 0;
  for (const name of names) {
    try {
      current = ensureTags(current, [name], ops).document;
    } catch {
      // A count, not the name and not the reason. The count is all the user can act on, and
      // it keeps this path structurally incapable of quoting the file.
      refused += 1;
    }
  }
  if (refused > 0) {
    warnings.push(
      importWarning(
        'dropped-value',
        `${refused} tag${refused === 1 ? '' : 's'} could not be given a sidebar entry. ` +
          'The records still carry them.'
      )
    );
  }
  return current;
}

// ── Writing new records ──────────────────────────────────────────────────────

interface WriteRecordsInput {
  readonly document: VaultDocument;
  readonly plan: HeldImportPlan;
  readonly decisions: readonly RecordDecision[];
  readonly extraTags: readonly string[];
  readonly folderIdByPath: ReadonlyMap<string, string>;
  readonly ops: OpsContext;
  readonly warnings: ImportWarning[];
  readonly onWriteProgress?: PlanProgress | undefined;
}

interface WriteRecordsOutput {
  readonly document: VaultDocument;
  readonly createdRecordIds: readonly string[];
  /** Parse index → the id of the record it became. Merges into the file's own rows need it. */
  readonly createdByIndex: ReadonlyMap<number, string>;
  readonly importedCount: number;
  readonly skippedCount: number;
}

function writeRecords(input: WriteRecordsInput): WriteRecordsOutput {
  const { plan, ops } = input;
  const createdRecordIds: string[] = [];
  const createdByIndex = new Map<number, string>();

  let document = input.document;
  let skipped = 0;
  const total = plan.secretRecords.length;
  // One tick per record on a 40,000-row import is 40,000 IPC messages nobody reads. A
  // hundred ticks is a bar that moves smoothly and a channel that stays usable.
  const step = Math.max(1, Math.floor(total / 100));

  for (const [index, record] of plan.secretRecords.entries()) {
    const decision = input.decisions[index];

    if (decision?.kind === 'skip') {
      skipped += 1;
    } else if (decision?.kind === 'import') {
      const credential = buildImported(record, index, input, ops);
      if (credential === null) {
        skipped += 1;
      } else {
        document = addCredential(document, credential);
        createdRecordIds.push(credential.id);
        createdByIndex.set(index, credential.id);
      }
    }

    if (index % step === 0 || index === total - 1) input.onWriteProgress?.(index + 1, total);
  }

  return {
    document,
    createdRecordIds,
    createdByIndex,
    importedCount: createdRecordIds.length,
    skippedCount: skipped,
  };
}

/** One record, or `null` when the vault refused it — in which case a warning is recorded. */
function buildImported(
  record: NewCredentialInput,
  index: number,
  input: WriteRecordsInput,
  ops: OpsContext
): Credential | null {
  try {
    return buildCredential(
      {
        ...record,
        // Provenance, not decoration: the record's `createdOrigin` says it arrived by import
        // rather than being typed, which is the first thing anyone asks of a record they do
        // not recognise a year later.
        action: 'import',
        tags: [...(record.tags ?? []), ...input.extraTags],
        folderId: resolveFolder(record, input.folderIdByPath),
        custom: rekeyCustomFields(record.custom ?? [], ops),
      },
      ops
    );
  } catch {
    input.warnings.push(
      importWarning(
        'skipped-row',
        // The position, and nothing else. The reason a record was refused is built out of the
        // value that broke the rule, and that value is a password as often as not.
        `Record ${index + 1} could not be imported because it does not fit inside a Keyhold record.`
      )
    );
    return null;
  }
}

/**
 * Re-keys the parser's record-scoped custom field ids through the vault's id source.
 *
 * `finishDraft` mints `imported-field-1` deliberately — a pure function must not create a
 * vault-wide identity for a record that may never be committed — and says the commit stage
 * may re-key them. This is that stage. The reveal path addresses a value by
 * (credential id, field id), so these want to be as unique as every other id in the vault.
 */
function rekeyCustomFields(fields: readonly CustomField[], ops: OpsContext): CustomField[] {
  return fields.map((field, order) => ({ ...field, id: ops.newId(), order }));
}

function resolveFolder(
  record: NewCredentialInput,
  folderIdByPath: ReadonlyMap<string, string>
): string | null {
  const path = placeholderPathOf(record);
  if (path === null) return null;
  const normalised = normaliseFolderPath(path);
  if (normalised === null) return null;
  return folderIdByPath.get(normalised.toLowerCase()) ?? null;
}

// ── Merging ──────────────────────────────────────────────────────────────────

interface ApplyMergesInput {
  readonly document: VaultDocument;
  readonly plan: HeldImportPlan;
  readonly decisions: readonly RecordDecision[];
  readonly createdByIndex: ReadonlyMap<number, string>;
  readonly createdRecordIds: ReadonlySet<string>;
  readonly folderIdByPath: ReadonlyMap<string, string>;
  readonly ops: OpsContext;
  readonly warnings: ImportWarning[];
}

interface ApplyMergesOutput {
  readonly document: VaultDocument;
  readonly snapshots: readonly Credential[];
  readonly mergedCount: number;
  /** Records the user asked to merge into a target that does not exist, or that was refused. */
  readonly skippedCount: number;
}

/**
 * Folds every merge decision into its target.
 *
 * Grouped by target rather than applied one record at a time, so `planMerge` sees the whole
 * cluster at once and its "the later row wins" rule means the row a person reading the file
 * top to bottom would expect — rather than whichever row happened to be applied last.
 *
 * The pre-merge record is snapshotted **once per target**, before the fold. Snapshotting per
 * row would record an already-half-merged state, and undo would restore that.
 */
function applyMerges(input: ApplyMergesInput): ApplyMergesOutput {
  const { plan, ops } = input;
  const byTarget = new Map<string, number[]>();
  let skipped = 0;

  for (const [index, decision] of input.decisions.entries()) {
    const targetId = targetOf(decision, input.createdByIndex);
    if (targetId === null) {
      // A merge whose lead row the vault refused. There is nothing to fold into, so it is
      // counted as skipped rather than dropped out of the arithmetic.
      if (decision.kind === 'merge-into-created') skipped += 1;
      continue;
    }
    const indices = byTarget.get(targetId);
    if (indices === undefined) byTarget.set(targetId, [index]);
    else indices.push(index);
  }

  let document = input.document;
  const snapshots: Credential[] = [];
  let merged = 0;

  for (const [targetId, indices] of byTarget) {
    const target = findCredential(document, targetId);
    if (target === null) {
      skipped += indices.length;
      continue;
    }

    const incoming: NewCredentialInput[] = [];
    for (const index of indices) {
      const record = plan.secretRecords[index];
      if (record !== undefined) incoming.push(record);
    }

    const { patch } = planMerge(target, incoming, {
      newId: ops.newId,
      folderIdFor: (path) => {
        const normalised = normaliseFolderPath(path);
        return normalised === null
          ? null
          : (input.folderIdByPath.get(normalised.toLowerCase()) ?? null);
      },
    });

    let updated;
    try {
      updated = applyPatch(target, patch, ops);
    } catch {
      input.warnings.push(
        importWarning(
          'skipped-row',
          `A merge into one record was refused because the result would not fit inside a ` +
            `Keyhold record. That record was left exactly as it was.`
        )
      );
      skipped += indices.length;
      continue;
    }

    merged += indices.length;
    if (updated.changedFields.length === 0) continue;

    // Only a record the vault already held needs putting back. One this import created is
    // removed outright by undo, and a snapshot of it would be a second copy of a password
    // held in memory for no reason.
    if (!input.createdRecordIds.has(targetId)) snapshots.push(target);

    document = replaceCredential(
      document,
      appendVersion(updated.credential, target, updated.changedFields, originFor(ops, 'import'))
    );
  }

  return { document, snapshots, mergedCount: merged, skippedCount: skipped };
}

function targetOf(
  decision: RecordDecision,
  createdByIndex: ReadonlyMap<number, string>
): string | null {
  if (decision.kind === 'merge-existing') return decision.credentialId;
  if (decision.kind === 'merge-into-created') {
    return createdByIndex.get(decision.leadIndex) ?? null;
  }
  return null;
}
