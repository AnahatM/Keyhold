// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  ImportCommitRequest,
  ImportCommitResult,
  ImportPreview,
  ImportPreviewRequest,
  ImportProgress,
  ImportSource,
  ImportSourceId,
  ImportUndoRequest,
  ImportUndoResult,
} from '@shared/model/import-plan.js';
import type { ImportFormatDescriptor } from '@shared/model/import.js';

/**
 * The one seam between the import wizard and the outside world.
 *
 * Every component in this folder is written against this interface and nothing else — no
 * `window.keyhold`, no channel names, no `IpcResult` unwrapping scattered through six
 * components. Two consequences, both deliberate:
 *
 * - **The wizard is testable without an Electron process.** `FakeImportGateway` in
 *   `fake-gateway.ts` implements this in memory, which is how the step machine, the dedupe
 *   decisions and the "cancel changes nothing" invariant are asserted at all.
 * - **Wiring the real channels is one file.** `createIpcImportGateway` adapts the preload
 *   bridge to this shape; whoever adds `kh:import:*` implements `ImporterApi` in
 *   `@shared/model/import-plan.ts` and changes nothing here.
 *
 * The methods throw {@link ImportGatewayError} rather than returning a result union. The
 * wizard has exactly one place that handles failure — the step body's error slot — and a
 * union would put an `if (!result.ok)` at every one of the nine call sites instead.
 */
export interface ImportGateway {
  listFormats(): Promise<readonly ImportFormatDescriptor[]>;
  /** Opens the main process's file dialog. `null` when the user cancelled it. */
  chooseFile(): Promise<ImportSource | null>;
  /** The dry run. Writes nothing; mints the plan id {@link commit} requires. */
  preview(request: ImportPreviewRequest): Promise<ImportPreview>;
  commit(request: ImportCommitRequest): Promise<ImportCommitResult>;
  undo(request: ImportUndoRequest): Promise<ImportUndoResult>;
  /** Drops the file, its parses and its plans. Called however the wizard closes. */
  discard(sourceId: ImportSourceId): Promise<void>;
  /** Commit progress. Returns the unsubscribe. */
  onProgress(listener: (progress: ImportProgress) => void): () => void;
}

/**
 * A failure that reached the wizard.
 *
 * Carries the structured `code` from `IpcFailure` so the UI can say something specific
 * about the handful of failures that have a specific answer — a stale plan, a vault that
 * moved under an undo — and falls back to the already-scrubbed message otherwise.
 *
 * The message is never allowed to carry a value from the file. That is the main process's
 * invariant (`IpcFailure.message` is documented as scrubbed) and this type inherits it.
 */
export class ImportGatewayError extends Error {
  readonly code: string;
  /** True when retrying with different input could work. */
  readonly recoverable: boolean;

  constructor(code: string, message: string, recoverable: boolean) {
    super(message);
    this.name = 'ImportGatewayError';
    this.code = code;
    this.recoverable = recoverable;
  }
}

/**
 * Codes the wizard reacts to by name rather than by message.
 *
 * Re-exported from the shared contract, not declared here. This file used to hold its own
 * copy of the two the wizard cares about, and the main process held its own copy of all six
 * — two lists either side of a process boundary, kept in step by a test that read one of
 * them as text.
 */
export { IMPORT_ERROR_CODES, type ImportErrorCode } from '@shared/model/import-plan.js';
