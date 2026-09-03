// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  ImportBatchId,
  ImportCommitRequest,
  ImportCommitResult,
  ImportDuplicateAction,
  ImportPlanId,
  ImportPreview,
  ImportPreviewRequest,
  ImportProgress,
  ImportProgressPhase,
  ImportSource,
  ImportSourceId,
  ImportUndoRequest,
  ImportUndoResult,
} from '@shared/model/import-plan.js';
import type { ImportFormatDescriptor } from '@shared/model/import.js';
import { uuid } from '../crypto/random.js';
import { importFormatDescriptors } from '../import/index.js';
import { commitImport, toDuplicateAction, type ImportBatchRecord } from './commit.js';
import { stalePlan, staleUndo } from './errors.js';
import type { ImportFilePicker } from './file-picker.js';
import { buildImportPlan, type HeldImportPlan } from './plan.js';
import { holdSource, type HeldSource } from './source-store.js';
import { undoImport } from './undo.js';
import type { ImportVaultAccess } from './vault-access.js';

/**
 * The import transaction, end to end.
 *
 * The parsers are pure functions from a string to records; the wizard is a state machine over
 * a gateway interface. This is what sits between them: it holds the chosen file, produces the
 * dry run, commits it into the vault, takes it back, and destroys what it was holding.
 *
 * ## Four properties, and where each one is enforced
 *
 * **A preview cannot commit.** `preview` mints an {@link ImportPlanId} and `commit` accepts
 * only that id plus the user's decisions. There is no shape the renderer can hand to `commit`
 * that describes *data* — it can only point at a parse this process already performed and is
 * still holding, which is why `ImportCommitRequest` carries no records, no mapping and no
 * format.
 *
 * **The preview runs the commit's code.** One parse, held (`plan.ts`), projected for the
 * screen and re-used for the write. The two cannot disagree because there is only one of
 * them.
 *
 * **Nothing secret crosses.** `ImportRecordPreview` is built by the shared `previewRecord`,
 * and every value that leaves this class goes through it. The parse itself — passwords,
 * notes, security answers, TOTP seeds — lives in `HeldImportPlan.secretRecords` and is read
 * only by `commit.ts`.
 *
 * **A cancelled import leaves nothing.** See {@link discard}.
 *
 * ## What is held, and for how long
 *
 * | Held | Contains | Dropped by |
 * | --- | --- | --- |
 * | the source | the file's bytes, in a `SecretBytes` | `discard`, which zeroes them |
 * | the plan | one parse: every password in the file | `discard`, `commit`, a newer preview |
 * | the batch | pre-merge copies of records the vault already had | `undo`, or the batch cap |
 *
 * Exactly one plan is kept per source. A second preview of the same file supersedes the
 * first rather than sitting beside it, so the number of plaintext parses this process holds
 * is bounded by the number of files the user has open, which is one.
 */

/**
 * How many committed batches stay undoable.
 *
 * Small, because a batch holds full copies — passwords included — of every vault record a
 * merge touched, and because the wizard only ever offers to undo the import it just ran. It
 * is not one, so that a user who imports two files back to back can still take back the
 * first.
 */
export const MAX_UNDOABLE_BATCHES = 8;

export interface ImportServiceOptions {
  readonly vault: ImportVaultAccess;
  readonly picker: ImportFilePicker;
  /** Pushed to the renderer as `kh:event:import-progress`. Absent in tests and headless use. */
  readonly onProgress?: ((progress: ImportProgress) => void) | undefined;
  /** The id source. Injected only so a test can read the ids it is asserting about. */
  readonly newId?: (() => string) | undefined;
}

interface HeldBatch {
  readonly record: ImportBatchRecord;
  /** The generation the commit's save produced. Undo refuses once the vault has moved past it. */
  readonly vaultGeneration: number;
}

export class ImportService {
  readonly #vault: ImportVaultAccess;
  readonly #picker: ImportFilePicker;
  readonly #onProgress: ((progress: ImportProgress) => void) | undefined;
  readonly #newId: () => string;

  readonly #sources = new Map<ImportSourceId, HeldSource>();
  readonly #plans = new Map<ImportPlanId, HeldImportPlan>();
  readonly #batches = new Map<ImportBatchId, HeldBatch>();

  constructor(options: ImportServiceOptions) {
    this.#vault = options.vault;
    this.#picker = options.picker;
    this.#onProgress = options.onProgress;
    this.#newId = options.newId ?? uuid;
  }

  /** The format registry, as descriptors. Never a parser. */
  formats(): readonly ImportFormatDescriptor[] {
    return importFormatDescriptors();
  }

  /**
   * Opens the dialog, reads the file, detects its format, and holds the content here.
   *
   * `null` when the user dismissed the dialog. Nothing is held in that case, which is the
   * only correct behaviour for a dialog someone pressed Escape on.
   */
  async chooseFile(): Promise<ImportSource | null> {
    const file = await this.#picker.pick();
    if (file === null) return null;

    const sourceId = this.#mint('source');
    const source = holdSource(sourceId, file);
    this.#sources.set(sourceId, source);
    return source.descriptor;
  }

  /**
   * The dry run. Writes nothing, and mints the plan id a commit requires.
   *
   * Synchronous by nature: the parsers are pure functions over a string, so there is nothing
   * to await. It runs on the main thread, which is acceptable because a parse is
   * milliseconds even for a large export — unlike Argon2, which is seconds by design and is
   * why the unlock path has a worker.
   */
  preview(request: ImportPreviewRequest): ImportPreview {
    const source = this.#sources.get(request.sourceId);
    if (source === undefined) throw stalePlan('That file is no longer open.');

    const planId = this.#mint('plan');
    this.#emit(planId, 'parsing', 0, 1);

    const plan = buildImportPlan({
      planId,
      sourceId: request.sourceId,
      formatId: request.formatId,
      // Decoded here and referenced nowhere else, so the plaintext copy of the file lives
      // for the duration of this call. A string cannot be zeroed; the next best thing is
      // for there never to be one that outlives the parse.
      secretText: source.readSecretText(),
      ...(request.mapping === undefined ? {} : { mapping: request.mapping }),
      sampleSize: request.sampleSize,
      document: this.#vault.document(),
      onMatchProgress: (completed, total) => {
        this.#emit(planId, 'matching', completed, total);
      },
    });

    // One plan per source. A superseded preview's parse is a second full copy of every
    // password in the file, kept alive for a screen the user has already moved on from.
    this.#forgetPlansOf(request.sourceId);
    this.#plans.set(planId, plan);
    return plan.preview;
  }

  async commit(request: ImportCommitRequest): Promise<ImportCommitResult> {
    const plan = this.#plans.get(request.planId);
    if (plan === undefined) throw stalePlan();
    // A plan whose file has been discarded must not still be committable: the user closed the
    // wizard, and "closed" has to mean the import cannot happen after the fact.
    //
    // Unreachable as written, and deliberately kept: `discard` drops the plans of the source
    // it destroys, so the line above already refuses this case and no test can reach here
    // through the public API. It is the assertion that keeps the two facts tied together — a
    // future `discard` that stopped forgetting plans would leave a committable import behind
    // a closed wizard, and this is the line that would still refuse it.
    if (!this.#sources.has(plan.sourceId)) throw stalePlan('That file is no longer open.');

    const outcome = commitImport({
      document: this.#vault.document(),
      plan,
      duplicateActions: normaliseActions(request.duplicateActions),
      extraTags: request.extraTags ?? [],
      ops: this.#vault.opsContext(),
      onWriteProgress: (completed, total) => {
        this.#emit(request.planId, 'writing', completed, total);
      },
    });

    // Consumed. Committing the same plan twice would import everything twice, and the
    // renderer holding a stale plan id is precisely the situation this class exists to make
    // harmless rather than trusted not to happen.
    this.#plans.delete(request.planId);

    this.#vault.replaceDocument(outcome.document);
    this.#emit(request.planId, 'saving', 0, 1);
    const vaultGeneration = await this.#vault.save();
    this.#emit(request.planId, 'saving', 1, 1);

    const batchId = this.#mint('batch');
    const undoable = hasAnythingToUndo(outcome.batch);
    if (undoable) this.#rememberBatch(batchId, { record: outcome.batch, vaultGeneration });

    return {
      batchId,
      importedCount: outcome.importedCount,
      skippedCount: outcome.skippedCount,
      mergedCount: outcome.mergedCount,
      createdFolderPaths: outcome.batch.createdFolderPaths,
      warnings: outcome.warnings,
      vaultGeneration,
      undoable,
    };
  }

  /**
   * Takes a committed import back.
   *
   * Refused unless the vault is in **exactly** the state the commit left it in: the caller's
   * expected generation, this batch's own generation, the vault's current generation, and no
   * unsaved changes. The generation alone is not enough — it moves only on a save, so a user
   * who edited an imported record and has not saved yet would slip past a generation-only
   * check and lose that edit to an undo that claimed it was only removing what it added.
   */
  async undo(request: ImportUndoRequest): Promise<ImportUndoResult> {
    const batch = this.#batches.get(request.batchId);
    if (batch === undefined) throw staleUndo();

    const generation = this.#vault.generation();
    if (
      request.expectedVaultGeneration !== generation ||
      batch.vaultGeneration !== generation ||
      this.#vault.hasUnsavedChanges()
    ) {
      throw staleUndo();
    }

    const outcome = undoImport(this.#vault.document(), batch.record);
    this.#vault.replaceDocument(outcome.document);
    await this.#vault.save();

    // Single use. A second undo of the same batch would be a no-op at best and, once the
    // ids have been reused by something else, a removal of records that are not ours.
    this.#batches.delete(request.batchId);

    return {
      undone: true,
      removedCount: outcome.removedCount,
      restoredCount: outcome.restoredCount,
      removedFolderPaths: outcome.removedFolderPaths,
    };
  }

  /**
   * Drops the file, every parse of it, and every plan derived from it.
   *
   * Called when the wizard closes, however it closes — cancelled, finished, or navigated
   * away from. What this destroys, precisely:
   *
   * - **The bytes**, zeroed by `SecretBytes.destroy()` rather than merely dereferenced, so
   *   the page is overwritten before it can be swapped or captured in a core dump.
   * - **Every parse**, dropped. A parse is an array of `NewCredentialInput` holding real
   *   passwords in JavaScript strings, and a string cannot be zeroed — dropping the last
   *   reference and letting the collector have it is the whole of what the runtime allows.
   *   That is exactly why the *bytes* are the thing kept in a zeroable form and the decoded
   *   text is never retained at all: the shape that can be destroyed is the one that lives.
   *
   * Committed batches deliberately survive a discard. The wizard closes its file the moment
   * the import lands and offers "undo" afterwards; dropping the batch here would withdraw
   * that offer at the exact moment it is made.
   */
  discard(sourceId: ImportSourceId): void {
    this.#forgetPlansOf(sourceId);
    const source = this.#sources.get(sourceId);
    if (source === undefined) return;
    source.destroy();
    this.#sources.delete(sourceId);
  }

  /**
   * Everything, including the batches.
   *
   * For the vault being locked or closed: an undo cannot mean anything against a vault that
   * is no longer open, and a batch's merge snapshots are records out of a vault whose key
   * has just been destroyed.
   */
  discardAll(): void {
    for (const source of this.#sources.values()) source.destroy();
    this.#sources.clear();
    this.#plans.clear();
    this.#batches.clear();
  }

  /** True while a file is held. For the caller that wants to know whether to call `discard`. */
  get heldSourceCount(): number {
    return this.#sources.size;
  }

  #forgetPlansOf(sourceId: ImportSourceId): void {
    for (const [planId, plan] of this.#plans) {
      if (plan.sourceId === sourceId) this.#plans.delete(planId);
    }
  }

  #rememberBatch(batchId: ImportBatchId, batch: HeldBatch): void {
    this.#batches.set(batchId, batch);
    // Oldest first, because `Map` preserves insertion order. Evicting rather than growing
    // keeps the number of retained plaintext record copies bounded by a constant.
    while (this.#batches.size > MAX_UNDOABLE_BATCHES) {
      const oldest = this.#batches.keys().next();
      if (oldest.done === true) break;
      this.#batches.delete(oldest.value);
    }
  }

  #emit(planId: ImportPlanId, phase: ImportProgressPhase, completed: number, total: number): void {
    this.#onProgress?.({ planId, phase, completed, total });
  }

  /**
   * An opaque handle.
   *
   * A UUID from the platform CSPRNG, prefixed only so a handle is legible in a stack trace.
   * Unguessable rather than sequential because these are the tokens that authorise a commit:
   * a counter would let a compromised renderer name a plan it was never given.
   */
  #mint(prefix: 'source' | 'plan' | 'batch'): string {
    return `${prefix}-${this.#newId()}`;
  }
}

/** Nothing was created and nothing was merged, so there is nothing to offer to take back. */
function hasAnythingToUndo(batch: ImportBatchRecord): boolean {
  return (
    batch.createdRecordIds.length > 0 ||
    batch.mergedSecretSnapshots.length > 0 ||
    batch.createdFolderIds.length > 0 ||
    batch.createdTagIds.length > 0
  );
}

/**
 * Rebuilds the decision map with only values that are actually one of the three answers.
 *
 * The map arrives over IPC, where the type annotation guarantees nothing. Anything
 * unrecognised becomes {@link DEFAULT_DUPLICATE_ACTION}, so the failure mode of a malformed
 * map is "changed nothing", never "imported duplicates".
 */
function normaliseActions(
  actions: Readonly<Record<string, unknown>> | undefined
): Readonly<Record<string, ImportDuplicateAction>> {
  const normalised: Record<string, ImportDuplicateAction> = {};
  for (const [key, value] of Object.entries(actions ?? {})) {
    normalised[key] = toDuplicateAction(value);
  }
  return normalised;
}
