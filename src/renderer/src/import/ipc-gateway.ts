// SPDX-License-Identifier: GPL-3.0-or-later
import type { IpcResult } from '@shared/ipc/api.js';
import type {
  ImportCommitRequest,
  ImportCommitResult,
  ImporterApi,
  ImportPreview,
  ImportPreviewRequest,
  ImportProgress,
  ImportSource,
  ImportSourceId,
  ImportUndoRequest,
  ImportUndoResult,
} from '@shared/model/import-plan.js';
import type { ImportFormatDescriptor } from '@shared/model/import.js';
import { ImportGatewayError, type ImportGateway } from './gateway.js';

/**
 * Adapts the preload bridge to {@link ImportGateway}.
 *
 * The whole file is `unwrap`. That is the point: the `IpcResult` union is checked in one
 * place instead of at every call site, and the wizard's components never learn that IPC
 * exists.
 *
 * It takes the bridge as an **argument** rather than reaching for `window.keyhold.importer`
 * itself, for two reasons. It compiles today, before the channels exist — the contract this
 * adapts (`ImporterApi`) is declared in `@shared/model/import-plan.ts`, and the preload will
 * satisfy it. And it stays substitutable: a test that wants the adapter's unwrapping without
 * an Electron process passes a stub bridge.
 *
 * Wiring, once `window.keyhold.importer` exists:
 *
 * ```ts
 * const gateway = createIpcImportGateway(window.keyhold.importer);
 * ```
 */
export function createIpcImportGateway(bridge: ImporterApi): ImportGateway {
  return {
    listFormats: async (): Promise<readonly ImportFormatDescriptor[]> =>
      unwrap(await bridge.formats()),

    chooseFile: async (): Promise<ImportSource | null> => unwrap(await bridge.chooseFile()),

    preview: async (request: ImportPreviewRequest): Promise<ImportPreview> =>
      unwrap(await bridge.preview(request)),

    commit: async (request: ImportCommitRequest): Promise<ImportCommitResult> =>
      unwrap(await bridge.commit(request)),

    undo: async (request: ImportUndoRequest): Promise<ImportUndoResult> =>
      unwrap(await bridge.undo(request)),

    discard: async (sourceId: ImportSourceId): Promise<void> => {
      unwrap(await bridge.discard(sourceId));
    },

    onProgress: (listener: (progress: ImportProgress) => void): (() => void) =>
      bridge.onProgress(listener),
  };
}

function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.value;
  throw new ImportGatewayError(result.code, result.message, result.recoverable);
}
