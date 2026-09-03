// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The main-process import service.
 *
 * `src/main/import/` parses; `src/renderer/src/import/` asks the questions. This is the
 * transaction between them: hold a file, produce a dry run, commit it, take it back, destroy
 * what was held.
 *
 * **`createElectronImportFilePicker` is deliberately not re-exported here.** It is the one
 * module in this folder that imports `electron`, and a barrel that pulled it in would make
 * every test of this service need an Electron process to load. Import it from
 * `./file-picker.js` directly, which only the IPC wiring ever needs to do.
 */

export { IMPORT_ERROR_CODES, ImportServiceError, type ImportErrorCode } from './errors.js';
export {
  ImportService,
  MAX_UNDOABLE_BATCHES,
  type ImportServiceOptions,
} from './import-service.js';
export { MAX_IMPORT_FILE_BYTES, type PickedImportFile } from './source-store.js';
export { createVaultImportAccess, type ImportVaultAccess } from './vault-access.js';
export type { ImportFilePicker } from './file-picker.js';
export type { ImportBatchRecord } from './commit.js';
export type { HeldImportPlan } from './plan.js';
