// SPDX-License-Identifier: GPL-3.0-or-later
import type { Credential } from '@shared/model/credential.js';
import type { VaultDocument } from '@shared/model/vault-document.js';
import type { LossLog } from './types.js';

/**
 * Which records an export covers.
 *
 * ## Trashed records are excluded unless someone says otherwise, in so many words
 *
 * A trashed record is one the user has already decided they do not want. Exporting it anyway
 * puts a credential they thought was deleted into a plaintext file they will email to
 * themselves, and they will never know it is in there — the file has no Trash view.
 *
 * So the default is exclusion, the opt-in is an explicit `true` rather than any truthy
 * value, and choosing it is *reported as a loss* so the number of hidden records is visible
 * either way. There is no option shape here that excludes them silently.
 */

export interface ExportSelection {
  /**
   * Include records the user has trashed. **Off unless explicitly `true`.**
   *
   * Optional-and-undefined rather than defaulted to `false` at the call site, so a caller
   * that forgets the field gets the safe behaviour rather than a compile error they might
   * fix by writing `true`.
   */
  readonly includeTrashed?: boolean | undefined;
  /**
   * Restrict the export to these record ids — the "chosen subset" a parcel carries.
   *
   * Absent means every record. Present-but-empty means an empty export, which is a strange
   * thing to ask for but not an error: the caller asked for nothing and gets nothing, rather
   * than silently getting everything.
   */
  readonly recordIds?: readonly string[] | undefined;
}

export interface SelectedRecords {
  /** In document order, always. Never the caller's id order — that would not be stable. */
  readonly records: readonly Credential[];
  /** Trashed records that were left out. Reported so the omission is visible. */
  readonly excludedTrashed: number;
  /** Ids that were asked for and are not in this vault. A caller passing a stale id. */
  readonly unknownIds: readonly string[];
}

export function selectRecords(
  document: VaultDocument,
  selection: ExportSelection = {}
): SelectedRecords {
  const wanted = selection.recordIds === undefined ? null : new Set(selection.recordIds);
  const found = new Set<string>();

  const records: Credential[] = [];
  let excludedTrashed = 0;

  // Document order, not `wanted` order: the same document and the same id set must produce
  // byte-identical output however the caller happened to assemble the list.
  for (const record of document.records) {
    if (wanted !== null && !wanted.has(record.id)) continue;
    found.add(record.id);

    if (record.trashedAt !== null && selection.includeTrashed !== true) {
      excludedTrashed += 1;
      continue;
    }
    records.push(record);
  }

  const unknownIds =
    wanted === null ? [] : [...(selection.recordIds ?? [])].filter((id) => !found.has(id));

  return { records, excludedTrashed, unknownIds };
}

/**
 * Reports what the selection left out, in the same list as everything else a format lost.
 *
 * Shared by every format so the sentence is written once. A trashed record excluded from a
 * CSV and one excluded from a parcel are the same omission and should not read differently
 * depending on which button was pressed.
 */
export function reportSelectionLosses(selected: SelectedRecords, losses: LossLog): void {
  if (selected.excludedTrashed > 0) {
    losses.add(
      'excluded',
      'trashed records',
      `${selected.excludedTrashed} record(s) in the Trash were not exported. Turn on “include trashed records” if you need them.`,
      selected.excludedTrashed
    );
  }
  if (selected.unknownIds.length > 0) {
    losses.add(
      'excluded',
      'unknown records',
      `${selected.unknownIds.length} of the record(s) you selected are no longer in this vault and were not exported.`,
      selected.unknownIds.length
    );
  }
}
