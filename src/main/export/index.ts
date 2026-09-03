// SPDX-License-Identifier: GPL-3.0-or-later
import type { VaultDocument } from '@shared/model/vault-document.js';
import { EXPORT_FORMATS, findExportFormat } from './formats.js';
import { exportCsv, type CsvExportOptions } from './csv.js';
import { exportEncrypted, type EncryptedExportOptions } from './encrypted.js';
import { exportCompatibleCsv, type CompatibleCsvOptions } from './generic-csv.js';
import { exportKeyholdJson, type KeyholdJsonOptions } from './keyhold-json.js';
import type { ExportOutput } from './types.js';

/**
 * One export request. The format decides which options are required, in the type.
 *
 * A single options bag with everything optional would have compiled just as well and would
 * have let `{ format: 'keyhold-parcel' }` through with no passphrase, to fail at runtime on
 * the one path where failing at runtime means an unencrypted file or none at all.
 */
export type ExportRequest =
  | ({ readonly format: 'keyhold-parcel' } & EncryptedExportOptions)
  | ({ readonly format: 'keyhold-json' } & KeyholdJsonOptions)
  | ({ readonly format: 'keyhold-csv' } & CsvExportOptions)
  | ({ readonly format: 'compatible-csv' } & CompatibleCsvOptions);

/**
 * Runs an export.
 *
 * Async for every format, including the three that are synchronous. One route in means the
 * caller writes one `await` and one warning check rather than branching on which formats
 * happen to need a key derivation today.
 */
export async function runExport(
  document: VaultDocument,
  request: ExportRequest
): Promise<ExportOutput> {
  switch (request.format) {
    case 'keyhold-parcel':
      return await exportEncrypted(document, request);
    case 'keyhold-json':
      return exportKeyholdJson(document, request);
    case 'keyhold-csv':
      return exportCsv(document, request);
    case 'compatible-csv':
      return exportCompatibleCsv(document, request);
  }
}

export { exportCsv, KEYHOLD_CSV_COLUMNS, type CsvExportOptions } from './csv.js';
export { exportEncrypted, type EncryptedExportOptions } from './encrypted.js';
export {
  COMPATIBLE_CSV_COLUMNS,
  exportCompatibleCsv,
  type CompatibleCsvOptions,
} from './generic-csv.js';
export {
  exportKeyholdJson,
  KEYHOLD_JSON_FORMAT,
  KEYHOLD_JSON_VERSION,
  parseKeyholdJson,
  serialiseKeyholdJson,
  type KeyholdJsonDocument,
  type KeyholdJsonOptions,
} from './keyhold-json.js';
export { selectRecords, type ExportSelection } from './select.js';
export {
  LossLog,
  reportOf,
  type EncryptedExport,
  type ExportOutput,
  type PlaintextExport,
} from './types.js';
export { writeCsv, type CsvWriteOptions } from './csv-writer.js';
export { EXPORT_FORMATS, findExportFormat };
export { previewExport, type ExportPreviewInput } from './preview.js';
export { parcelPlan } from './encrypted.js';
