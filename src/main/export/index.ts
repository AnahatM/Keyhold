// SPDX-License-Identifier: GPL-3.0-or-later
import type { ExportFormatDescriptor, ExportFormatId } from '@shared/model/export.js';
import type { VaultDocument } from '@shared/model/vault-document.js';
import { exportCsv, type CsvExportOptions } from './csv.js';
import { exportEncrypted, type EncryptedExportOptions } from './encrypted.js';
import { exportCompatibleCsv, type CompatibleCsvOptions } from './generic-csv.js';
import { exportKeyholdJson, type KeyholdJsonOptions } from './keyhold-json.js';
import type { ExportOutput } from './types.js';

/**
 * The format registry — **the** format registry.
 *
 * Rule 8: no second list. The format dropdown, the save dialog's filter, the default file
 * name and `runExport` all read this array, so adding a format is one entry and one branch
 * and there is no second place to forget. `index.test.ts` asserts every `ExportFormatId` has
 * exactly one descriptor, which is what keeps the union and the array from drifting.
 *
 * Order is the order the dialog shows them in, and it is deliberate: **the encrypted parcel
 * is first**. It is the right answer for almost every reason a person exports — moving to a
 * new machine, handing a few logins to a colleague, keeping a copy somewhere — and putting
 * a plaintext dump of the whole vault at the top of the list would make the dangerous option
 * the obvious one. The lossless plaintext format comes next because it is the one that
 * actually preserves everything; the two CSVs are last, in the order of how much they lose.
 */
export const EXPORT_FORMATS: readonly ExportFormatDescriptor[] = [
  {
    id: 'keyhold-parcel',
    name: 'Encrypted parcel',
    extension: '.keepx',
    description:
      'The chosen records, sealed under a passphrase of their own. Safe to send or store.',
    encrypted: true,
    lossless: true,
  },
  {
    id: 'keyhold-json',
    name: 'Keyhold JSON',
    extension: '.json',
    description: 'Everything, in readable text: every field, every version, every origin.',
    encrypted: false,
    lossless: true,
  },
  {
    id: 'keyhold-csv',
    name: 'Spreadsheet (CSV)',
    extension: '.csv',
    description: 'A flat table of the vault, for reading and auditing. Drops history.',
    encrypted: false,
    lossless: false,
  },
  {
    id: 'compatible-csv',
    name: 'Other password managers (CSV)',
    extension: '.csv',
    description: 'Bitwarden’s column set — the one most other managers will import.',
    encrypted: false,
    lossless: false,
  },
];

export function findExportFormat(id: ExportFormatId): ExportFormatDescriptor | null {
  return EXPORT_FORMATS.find((format) => format.id === id) ?? null;
}

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
