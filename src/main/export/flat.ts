// SPDX-License-Identifier: GPL-3.0-or-later
import type { Credential, CustomField } from '@shared/model/credential.js';
import { FOLDER_PATH_SEPARATOR } from '@shared/model/import.js';
import type { Folder, VaultDocument } from '@shared/model/vault-document.js';
import type { LossLog } from './types.js';

/**
 * What both flat formats share: how a tree becomes a path, how a repeatable field becomes
 * one cell, and the honest list of what a single row cannot hold.
 *
 * ## The shape of the problem
 *
 * A credential is a tree — several URLs, any number of typed custom fields, a list of
 * security questions, a timeline of versions each with its own provenance. A CSV row is a
 * fixed list of strings. Something has to give, and the only question is whether the user is
 * told what gave.
 *
 * The three moves available are: **flatten** it into one cell, **drop** it, or **invent extra
 * rows**. The third is refused outright. One row per version, or per URL, would produce a
 * file that re-imports as several near-identical records — silently multiplying the user's
 * vault, with duplicates that look deliberate. A user who exports 400 records and imports
 * 1,700 has lost more than they would have by dropping history.
 *
 * So repeatable values are packed into a single cell in the format Bitwarden's own export
 * uses (`label: value`, one per line), which Keyhold's importer already reads back, and
 * everything a cell genuinely cannot carry is dropped **and named**.
 */

// ── Cells ────────────────────────────────────────────────────────────────────

/**
 * A folder's full path, `/`-separated, matching what the importers' `normaliseFolderPath`
 * produces. `''` for a record in no folder, or one pointing at a folder that is not there.
 */
export function folderPathOf(folders: readonly Folder[], folderId: string | null): string {
  if (folderId === null) return '';

  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const segments: string[] = [];

  let current: string | null = folderId;
  // Bounded by the folder count. A parent chain that loops — from a bad merge, or a hand-
  // edited file — would otherwise hang the export rather than producing a slightly wrong path.
  for (let step = 0; current !== null && step <= byId.size; step += 1) {
    const folder: Folder | undefined = byId.get(current);
    if (folder === undefined) break;
    segments.unshift(folder.name);
    current = folder.parentId;
  }

  return segments.join(FOLDER_PATH_SEPARATOR);
}

/**
 * Packs `label: value` pairs into one cell, one per line.
 *
 * Deliberately Bitwarden's packing rather than something better: it is what the widest set
 * of importers already understands, and `parsePackedFields` in `src/main/import` reads it
 * back, so a Keyhold CSV round-trips through Keyhold's own importer without a special case.
 *
 * Its known limit, inherited along with the format: a value containing a line that itself
 * contains a colon is re-split on the way back in. Multi-line values without colons survive,
 * because a line with no colon is read as a continuation of the previous value.
 */
export function packLabelledValues(entries: readonly (readonly [string, string])[]): string {
  return entries
    .filter(([, value]) => value !== '')
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

/**
 * Several URLs in one cell, newline-separated.
 *
 * Newlines rather than commas for the same reason `splitUrls` reads them that way: a comma is
 * legal inside a query string, so a comma-joined cell would be bisected in the wrong place on
 * the way back in.
 */
export function joinUrls(urls: readonly string[]): string {
  return urls.join('\n');
}

/**
 * A timestamp as ISO 8601, or `''` for none.
 *
 * ISO rather than epoch milliseconds because a spreadsheet is the destination: `2026-09-02`
 * sorts, filters and reads correctly in Excel, and `1788000000000` does none of those things.
 * It also round-trips exactly, so nothing is lost by being readable.
 */
export function isoOrEmpty(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toISOString();
}

/** Exports spell "true" many ways; `1` and empty is the one every importer here accepts. */
export function flagCell(value: boolean): string {
  return value ? '1' : '';
}

// ── The losses every flat format has ─────────────────────────────────────────

/**
 * Records the losses that are a property of *being flat*, not of a particular column set.
 *
 * Called by both CSV exporters so the sentences are written once. A user comparing the two
 * formats should not have to work out whether two differently-worded warnings mean the same
 * thing.
 */
export function reportFlatLosses(
  document: VaultDocument,
  records: readonly Credential[],
  losses: LossLog
): void {
  for (const record of records) {
    if (record.history.versions.length > 0) {
      losses.countRecord(
        'dropped',
        'history',
        (count) =>
          `Password history and the device/network origin of each change were not carried on ${count} record(s). A row cannot hold a timeline — export to Keyhold JSON to keep it.`
      );
    }
    if (record.attachments.length > 0) {
      losses.countRecord(
        'dropped',
        'attachments',
        (count) => `Attached files were not carried on ${count} record(s). A CSV holds text only.`
      );
    }
    if (record.icon.kind !== 'auto') {
      losses.countRecord(
        'dropped',
        'icon',
        (count) => `A chosen icon was not carried on ${count} record(s).`
      );
    }
    if (record.fields.custom.length > 0) {
      losses.countRecord(
        'flattened',
        'custom field type',
        (count) =>
          `Custom fields on ${count} record(s) were packed into one cell, which keeps their labels and values but not their field type or their “hidden” setting.`
      );
    }
  }

  if (records.length > 0) {
    losses.add(
      'dropped',
      'record identity',
      'Record ids are not written to a CSV, so importing this file back creates new records rather than updating the existing ones.',
      records.length
    );
  }

  losses.add(
    'dropped',
    'vault settings',
    'Vault settings — history retention, the audit privacy level, trash retention — are not part of a CSV and were not carried.'
  );

  if (document.tags.length > 0) {
    losses.add(
      'dropped',
      'tag colours',
      'Tag names are carried; the colour assigned to each tag is not.',
      document.tags.length
    );
  }
}

/**
 * Reports the cells that were rewritten to stop a spreadsheet executing them.
 *
 * Separate from the rest because it is the one loss where the *value in the file differs
 * from the value in the vault*. It has to be visible: a user re-importing this file will get
 * a leading apostrophe on those passwords, and finding that out from a failed login is a bad
 * way to learn it.
 */
export function reportNeutralisedCells(
  neutralised: readonly { readonly column: string; readonly cells: number }[],
  losses: LossLog
): void {
  for (const { column, cells } of neutralised) {
    losses.add(
      'altered',
      column,
      `${cells} value(s) in the "${column}" column began with a character a spreadsheet would run as a formula, so an apostrophe was added in front. Spreadsheets hide it; other readers do not.`,
      cells
    );
  }
}

/** Custom fields as `label: value` pairs, in stored display order. */
export function customFieldEntries(fields: readonly CustomField[]): [string, string][] {
  return fields.map((field) => [field.label, field.value]);
}
