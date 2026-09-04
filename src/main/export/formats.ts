// SPDX-License-Identifier: GPL-3.0-or-later
import type { ExportFormatDescriptor, ExportFormatId } from '@shared/model/export.js';

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
 *
 * KDBX sits second, directly under the parcel, because it is the other encrypted option and
 * the two belong together: whichever the user is after, neither writes a readable file. It is
 * below the parcel rather than above it only because a parcel is lossless and this is not.
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
    id: 'kdbx',
    name: 'KeePass database (KDBX 4)',
    extension: '.kdbx',
    description:
      'KeePass’s own encrypted format, under a passphrase of its own. Opens in KeePassXC and every mobile client.',
    encrypted: true,
    lossless: false,
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
    id: 'bitwarden-json',
    name: 'Bitwarden (JSON)',
    extension: '.json',
    description: 'Bitwarden’s own export. Keeps field types, folders and multiple addresses.',
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
