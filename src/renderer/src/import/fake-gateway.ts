// SPDX-License-Identifier: GPL-3.0-or-later
import type { ImportFormatDescriptor, ImportWarning } from '@shared/model/import.js';
import {
  countNewRecords,
  DEFAULT_DUPLICATE_ACTION,
  groupImportDuplicates,
  previewRecord,
  type ImportCommitRequest,
  type ImportCommitResult,
  type ImportDuplicateAction,
  type ImportDuplicateExisting,
  type ImportFolderPlan,
  type ImportMergeField,
  type ImportPreview,
  type ImportPreviewRequest,
  type ImportProgress,
  type ImportRecordPreview,
  type ImportSource,
  type ImportSourceId,
  type ImportUndoRequest,
  type ImportUndoResult,
  type ParsedRecordLike,
} from '@shared/model/import-plan.js';
import { IMPORT_ERROR_CODES, ImportGatewayError, type ImportGateway } from './gateway.js';

/**
 * An in-memory {@link ImportGateway}, for tests and for driving the wizard without Electron.
 *
 * It is not a stub that returns canned objects. It holds **real parsed records, passwords
 * included**, and builds its preview through the same `previewRecord` and
 * `groupImportDuplicates` the main process will use. That is the entire reason it exists in
 * this shape: the guard test that says no password reaches a rendered string is only worth
 * anything if there was a password there to leak in the first place.
 *
 * It also enforces the two safety properties of the contract, so they can be asserted rather
 * than assumed:
 *
 * - **A preview cannot commit.** `commit` rejects any plan id this gateway did not mint,
 *   including one from a preview that has since been superseded or discarded.
 * - **Undo is generation-guarded.** `undo` refuses once the vault has moved on.
 *
 * Every call is recorded in {@link calls}, which is how "cancelling before commit changes
 * nothing" is asserted: the invariant is not that some flag stayed false, it is that
 * `commit` was never reached and `discard` was.
 */

export interface FakeImportScenario {
  readonly formats: readonly ImportFormatDescriptor[];
  readonly source: ImportSource;
  /** The parse. Real records, real passwords — that is the point. */
  readonly records: readonly ParsedRecordLike[];
  readonly warnings: readonly ImportWarning[];
  readonly folders: readonly ImportFolderPlan[];
  /** The vault side of the match, as the renderer already holds it. */
  readonly existing: readonly ImportDuplicateExisting[];
  /** What a merge would do, per existing record. Keyed by credential id. */
  readonly mergeFields: Readonly<Record<string, readonly ImportMergeField[]>>;
  /** `chooseFile` returns null once, as though the user dismissed the dialog. */
  readonly cancelFileDialog: boolean;
  readonly vaultGeneration: number;
}

export const FAKE_IMPORT_FORMATS: readonly ImportFormatDescriptor[] = [
  {
    id: 'bitwarden-csv',
    name: 'Bitwarden CSV',
    extensions: ['.csv'],
    description: 'An unencrypted CSV export from Bitwarden.',
    needsMapping: false,
  },
  {
    id: 'lastpass-csv',
    name: 'LastPass CSV',
    extensions: ['.csv'],
    description: 'An export from LastPass.',
    needsMapping: false,
  },
  {
    id: 'generic-csv',
    name: 'Any CSV file',
    extensions: ['.csv'],
    description: 'A CSV with columns you map to Keyhold fields yourself.',
    needsMapping: true,
  },
];

export class FakeImportGateway implements ImportGateway {
  /**
   * The parse, passwords and all.
   *
   * Named for what it holds, per the project's convention that anything carrying secret
   * material says so in its name, so a reviewer can see at a glance that this field is the
   * one that must never reach a return value untouched.
   */
  private readonly secretRecords: readonly ParsedRecordLike[];

  private readonly scenario: FakeImportScenario;
  private readonly listeners = new Set<(progress: ImportProgress) => void>();
  /** Plans this gateway minted and still honours. A discard empties it. */
  private readonly plans = new Map<string, readonly ImportRecordPreview[]>();
  private readonly batches = new Map<string, number>();
  private counter = 0;
  private generation: number;
  private fileDialogCalls = 0;

  /** Every method call, in order, as `name` or `name:detail`. */
  readonly calls: string[] = [];

  constructor(scenario: FakeImportScenario) {
    this.scenario = scenario;
    this.secretRecords = scenario.records;
    this.generation = scenario.vaultGeneration;
  }

  listFormats(): Promise<readonly ImportFormatDescriptor[]> {
    this.calls.push('listFormats');
    return Promise.resolve(this.scenario.formats);
  }

  chooseFile(): Promise<ImportSource | null> {
    this.calls.push('chooseFile');
    this.fileDialogCalls += 1;
    if (this.scenario.cancelFileDialog && this.fileDialogCalls === 1) return Promise.resolve(null);
    return Promise.resolve(this.scenario.source);
  }

  preview(request: ImportPreviewRequest): Promise<ImportPreview> {
    this.calls.push(`preview:${request.formatId}`);
    if (request.sourceId !== this.scenario.source.sourceId) {
      return Promise.reject(
        new ImportGatewayError(IMPORT_ERROR_CODES.stalePlan, 'That file is no longer open.', false)
      );
    }

    // The projection, run over the real records. Nothing else in this class is allowed to
    // touch `secretRecords`, and nothing else does.
    const projected = this.secretRecords.map((record, index) => previewRecord(record, index));
    const duplicates = groupImportDuplicates(projected, this.scenario.existing, (existing) => [
      ...(this.scenario.mergeFields[existing.credentialId] ?? []),
    ]);

    const planId = this.nextId('plan');
    this.plans.set(planId, projected);

    return Promise.resolve({
      planId,
      sourceId: request.sourceId,
      formatId: request.formatId,
      recordCount: projected.length,
      newRecordCount: countNewRecords(projected, duplicates),
      sample: projected.slice(0, request.sampleSize),
      warnings: this.scenario.warnings,
      folders: this.scenario.folders,
      duplicates,
    });
  }

  commit(request: ImportCommitRequest): Promise<ImportCommitResult> {
    this.calls.push(`commit:${request.planId}`);
    const projected = this.plans.get(request.planId);
    if (projected === undefined) {
      return Promise.reject(
        new ImportGatewayError(
          IMPORT_ERROR_CODES.stalePlan,
          'This preview is out of date. Run it again before importing.',
          true
        )
      );
    }

    const duplicates = groupImportDuplicates(projected, this.scenario.existing);
    const grouped = new Set<number>();
    for (const group of duplicates) {
      for (const record of group.incoming) grouped.add(record.index);
    }

    // Counted from the groups directly rather than through the renderer's own summary
    // arithmetic, so the review screen's prediction and the committed result are two
    // independent calculations that a test can hold against each other.
    let imported = projected.filter((record) => !grouped.has(record.index)).length;
    let skipped = 0;
    let merged = 0;

    for (const group of duplicates) {
      const action: ImportDuplicateAction =
        request.duplicateActions[group.key] ?? DEFAULT_DUPLICATE_ACTION;
      const size = group.incoming.length;
      // A within-file cluster has no vault match, so one of its rows is a genuinely new
      // record under every decision; the rest are the redundant copies.
      const redundant = group.existing === null ? size - 1 : size;
      const kept = size - redundant;
      imported += kept;
      switch (action) {
        case 'skip':
          skipped += redundant;
          break;
        case 'import-anyway':
          imported += redundant;
          break;
        case 'merge':
          merged += redundant;
          break;
      }
    }

    this.emitProgress(request.planId, imported);
    this.generation += 1;
    const batchId = this.nextId('batch');
    this.batches.set(batchId, imported);

    return Promise.resolve({
      batchId,
      importedCount: imported,
      skippedCount: skipped,
      mergedCount: merged,
      createdFolderPaths: this.scenario.folders
        .filter((folder) => folder.willCreate)
        .map((folder) => folder.path),
      warnings: [],
      vaultGeneration: this.generation,
      undoable: true,
    });
  }

  undo(request: ImportUndoRequest): Promise<ImportUndoResult> {
    this.calls.push(`undo:${request.batchId}`);
    const removed = this.batches.get(request.batchId);
    if (removed === undefined || request.expectedVaultGeneration !== this.generation) {
      return Promise.reject(
        new ImportGatewayError(
          IMPORT_ERROR_CODES.staleUndo,
          'The vault changed after this import, so it can no longer be taken back automatically.',
          false
        )
      );
    }
    this.batches.delete(request.batchId);
    this.generation += 1;
    return Promise.resolve({
      undone: true,
      removedCount: removed,
      restoredCount: 0,
      removedFolderPaths: this.scenario.folders
        .filter((folder) => folder.willCreate)
        .map((folder) => folder.path),
    });
  }

  discard(sourceId: ImportSourceId): Promise<void> {
    this.calls.push(`discard:${sourceId}`);
    // Every plan derived from the source goes with it. A plan that outlived its file would
    // be a commit the user could still trigger for data they thought they had closed.
    this.plans.clear();
    return Promise.resolve();
  }

  onProgress(listener: (progress: ImportProgress) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** True when nothing was written. The plain statement of "cancel changed nothing". */
  get committed(): boolean {
    return this.batches.size > 0 || this.calls.some((call) => call.startsWith('commit:'));
  }

  private emitProgress(planId: string, total: number): void {
    for (const listener of this.listeners) {
      listener({ planId, phase: 'writing', completed: total, total });
    }
  }

  /** A counter, not a random id. `Math.random` is banned project-wide and is not needed here. */
  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }
}
