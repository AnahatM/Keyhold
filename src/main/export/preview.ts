// SPDX-License-Identifier: GPL-3.0-or-later
import type { AttachmentChunk } from '@shared/format/types.js';
import type { ExportFormatId } from '@shared/model/export.js';
import type { ExportPreview, ExportScope } from '@shared/model/export-plan.js';
import type { VaultDocument } from '@shared/model/vault-document.js';
import { parcelPlan } from './encrypted.js';
import { kdbxPlan } from './kdbx.js';
import { findExportFormat } from './formats.js';
import { exportBitwardenJson } from './bitwarden-json.js';
import { exportCompatibleCsv } from './generic-csv.js';
import { exportCsv } from './csv.js';
import { exportKeyholdJson } from './keyhold-json.js';
import { selectRecords, type ExportSelection } from './select.js';
import type { PlaintextExport } from './types.js';

/**
 * What an export would cost, computed without writing anything.
 *
 * ## Why the preview runs the real exporter
 *
 * For the three readable formats this function does the entire export, in memory, and then
 * throws the bytes away. That is wasteful and it is the point: the loss list the dialog
 * shows is then *literally* the loss list the file would carry, produced by the same code on
 * the same records. A preview that reimplemented "CSV drops history" in its own words would
 * be right until the day someone changed what CSV drops, and the dialog would go on
 * confidently describing the old behaviour with nothing to catch it.
 *
 * The promise in the docs -- "it is impossible to export a CSV and be surprised that history
 * is gone" -- is only true if this is the same computation. So it is.
 *
 * The parcel is the one exception, and {@link parcelPlan} explains why: sealing it means an
 * Argon2id derivation, which is a second of work for a result that gets discarded, and the
 * derivation has no bearing on what is lost. Its losses still come from shared code.
 *
 * ## The bytes
 *
 * `secretBytes` from a discarded plaintext export is a complete copy of every password in
 * scope, sitting in a buffer nobody asked for. It is zeroed before this function returns.
 * That does not make it safe -- V8 may have copied it during construction, and this cannot
 * reach those copies -- but it removes the one reference we do control, and it costs a loop.
 */
export interface ExportPreviewInput {
  readonly format: ExportFormatId;
  readonly scope: ExportScope;
  /** Injected rather than read, so a preview is reproducible in a test. */
  readonly now: number;
  /** The chunks the open vault holds. Only their ids matter here. */
  readonly attachments?: readonly AttachmentChunk[] | undefined;
}

export function previewExport(document: VaultDocument, input: ExportPreviewInput): ExportPreview {
  const descriptor = findExportFormat(input.format);
  if (descriptor === null) throw new Error(`Unknown export format: ${input.format}`);

  const selection = {
    includeTrashed: input.scope.includeTrashed,
    ...(input.scope.recordIds === null ? {} : { recordIds: input.scope.recordIds }),
  };
  const selected = selectRecords(document, selection);

  // Reported whether or not they would be written, because "12 records in the Trash are
  // being left out" and "12 will be included" are the same fact and the user is owed it in
  // both directions. When they are included they are in `records`, so they have to be
  // counted there instead of read off `excludedTrashed`.
  const trashedInScope = input.scope.includeTrashed
    ? selected.records.filter((record) => record.trashedAt !== null).length
    : selected.excludedTrashed;

  const base = {
    format: input.format,
    recordCount: selected.records.length,
    trashedInScope,
    unknownIds: selected.unknownIds.length,
    containsSecrets: !descriptor.encrypted,
  } as const;

  if (input.format === 'keyhold-parcel') {
    const { losses } = parcelPlan(selected, input.attachments ?? []);
    losses.flush();
    return { ...base, losses: losses.all };
  }

  // The other encrypted format, and the reason `kdbxPlan` is a function of its own: a preview
  // must show what a KDBX export will drop **before** the user commits to a passphrase, and
  // it must not spend Argon2's seconds to find out. One function, two callers, so the screen
  // cannot promise one thing while the file does another.
  if (input.format === 'kdbx') {
    const losses = kdbxPlan(selected);
    losses.flush();
    return { ...base, losses: losses.all };
  }

  const output = runReadableExport(document, input, selection);
  try {
    // `recordCount` from the exporter, not from `selected`: if the two ever disagree the
    // exporter is right, because it is the one that wrote the rows.
    return { ...base, recordCount: output.recordCount, losses: output.losses };
  } finally {
    output.secretBytes.fill(0);
  }
}

function runReadableExport(
  document: VaultDocument,
  input: ExportPreviewInput,
  selection: ExportSelection
): PlaintextExport {
  const options = { ...selection, now: input.now };
  switch (input.format) {
    case 'keyhold-json':
      return exportKeyholdJson(document, options);
    case 'keyhold-csv':
      return exportCsv(document, options);
    case 'compatible-csv':
      return exportCompatibleCsv(document, options);
    // No `now`: Bitwarden's envelope carries no export timestamp, so the file is deterministic
    // for a given vault and there is nothing for a clock to stamp.
    case 'bitwarden-json':
      return exportBitwardenJson(document, selection);
    case 'keyhold-parcel':
    case 'kdbx':
      // Unreachable: both encrypted formats returned above, from `previewExport`. Named as
      // cases rather than left to a `default`, so adding a format is a non-exhaustive-switch
      // error here instead of a preview that silently reports no losses at all.
      throw new Error(`No readable preview path for export format: ${input.format}`);
  }
}
