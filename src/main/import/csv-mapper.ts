// SPDX-License-Identifier: GPL-3.0-or-later
import type { CustomFieldType } from '@shared/model/credential.js';
import {
  normaliseColumnKey,
  normaliseFolderPath,
  type ImportFieldTarget,
  type ImportWarningKind,
} from '@shared/model/import.js';
import { parseCsvTable, type CsvRow, type CsvTable } from './csv.js';
import {
  addCustom,
  addNote,
  addUrls,
  finishDraft,
  FolderSet,
  isTruthy,
  newDraft,
  splitList,
  WarningLog,
  type DraftRecord,
} from './mapping.js';
import type { NewCredentialInput } from '../vault/credential-ops.js';
import type { ImportResult } from './types.js';

/**
 * The engine every CSV parser runs on.
 *
 * A CSV importer is, almost entirely, *a column→field mapping plus two or three quirks*. The
 * quirks are real — Bitwarden packs custom fields into one cell, LastPass marks secure notes
 * with a fake URL — but the other ninety percent is identical across eleven formats. Writing
 * it once means a fix to title derivation, or to how a folder path is normalised, or to how
 * an unmapped column is reported, lands in every format at the same time instead of ten out
 * of eleven.
 *
 * It is also what makes `generic-csv.ts` cheap: the catch-all is this engine with the user's
 * mapping instead of a built-in one.
 */

export interface CsvRowContext {
  readonly row: CsvRow;
  /** Reads a cell by column name, trying each candidate in order. Returns `''` if none match. */
  value(...columns: string[]): string;
  /** Marks a column as handled, so it is not carried a second time as a custom field. */
  consume(...columns: string[]): void;
  warn(kind: ImportWarningKind, message: string): void;
}

/** Runs before the generic column pass, so it can `consume` columns it handles itself. */
export type CsvRowHook = (draft: DraftRecord, context: CsvRowContext) => void;

/**
 * Decides whether a row becomes a record at all. Returns the reason to skip, or `null`.
 *
 * A return value rather than a callback on purpose: a `context.skip()` that set a captured
 * flag would be invisible to TypeScript's flow analysis, which would then believe the flag is
 * still `false` at the point it is read. That is exactly the kind of quiet unsoundness this
 * project's strict settings exist to refuse.
 */
export type CsvRowFilter = (context: CsvRowContext) => string | null;

export interface CsvMappingSpec {
  /**
   * Normalised column key → target. A column absent from this map is carried as a custom
   * field *and* reported, which is the whole point: an export that grows a column between
   * versions must not lose it just because this table was written first.
   */
  readonly targets: Readonly<Record<string, ImportFieldTarget>>;
  /** Why a `drop` column does not survive. Shown to the user, once per column, by name. */
  readonly dropReasons?: Readonly<Record<string, string>>;
  /** Forces the type of a `custom` column when the guess would be wrong. */
  readonly customTypes?: Readonly<Record<string, CustomFieldType>>;
  /** Overrides the label of a `custom` column. Defaults to the header text as written. */
  readonly customLabels?: Readonly<Record<string, string>>;
  /** The label given to a `totp` column's custom field. */
  readonly totpLabel?: string;
  /**
   * Report every `custom` column, not only the ones missing from `targets`.
   *
   * A named parser choosing `custom` for `cardnumber` has made a decision, and warning about
   * it would be noise. The *inferred* generic mapping has made a guess, and not saying so
   * would hide the guess — the user has no other way to learn that a column they cared about
   * ended up in the custom-field list.
   */
  readonly reportInferredCustom?: boolean;
  /** Per-row escape hatch for format quirks. */
  readonly hook?: CsvRowHook;
  /** Decides which rows are not records at all — 1Password's archived items, say. */
  readonly skipRow?: CsvRowFilter;
}

const DEFAULT_TOTP_LABEL = 'One-time password';

/**
 * Parses a CSV string and maps it through `spec`.
 *
 * Never throws. A file that is not CSV at all yields zero records and a warning, which is
 * what the wizard wants to show — an exception here would take down a preview the user is
 * still choosing a format in.
 */
export function mapCsv(content: string, spec: CsvMappingSpec): ImportResult {
  const { table, warnings } = parseCsvTable(content);
  const log = new WarningLog();
  log.addAll(warnings);

  if (table.columns.length === 0) {
    log.add('format', 'The file is empty — there is not even a header row.');
    return { records: [], warnings: log.all, folders: [] };
  }

  return mapCsvTable(table, spec, log);
}

/** The mapping half, split out so a parser that already has a table can reuse it. */
export function mapCsvTable(table: CsvTable, spec: CsvMappingSpec, log: WarningLog): ImportResult {
  const records: NewCredentialInput[] = [];
  const folders = new FolderSet();
  const droppedColumns = new WarningLog();

  for (const row of table.rows) {
    const handled = new Set<string>();
    const draft = newDraft();

    const context: CsvRowContext = {
      row,
      value: (...columns) => firstValue(row, columns),
      consume: (...columns) => {
        for (const column of columns) handled.add(normaliseColumnKey(column));
      },
      warn: (kind, message) => {
        log.add(kind, message, row.line);
      },
    };

    const skipReason = spec.skipRow?.(context) ?? null;
    if (skipReason !== null) {
      log.add('skipped-row', `Line ${row.line} was not imported: ${skipReason}`, row.line);
      continue;
    }

    spec.hook?.(draft, context);

    table.keys.forEach((key, position) => {
      if (key === '' || handled.has(key)) return;
      const value = row.values.get(key) ?? '';
      if (value.trim() === '') return;

      const target = spec.targets[key] ?? 'custom';
      const label = spec.customLabels?.[key] ?? table.columns[position] ?? key;

      switch (target) {
        case 'title':
          if (draft.title === '') draft.title = value;
          else addCustom(draft, label, value);
          break;
        case 'username':
          if (draft.username === '') draft.username = value;
          else addCustom(draft, label, value);
          break;
        case 'email':
          if (draft.email === '') draft.email = value;
          else addCustom(draft, label, value, 'email');
          break;
        case 'password':
          if (draft.password === '') draft.password = value;
          else addCustom(draft, label, value, 'password');
          break;
        case 'url':
          addUrls(draft, value);
          break;
        case 'notes':
          addNote(draft, value);
          break;
        case 'folder':
          draft.folderPath ??= normaliseFolderPath(value);
          break;
        case 'tags':
          draft.tags.push(...splitList(value));
          break;
        case 'favorite':
          draft.favorite = draft.favorite || isTruthy(value);
          break;
        case 'totp':
          addCustom(draft, spec.totpLabel ?? DEFAULT_TOTP_LABEL, value, 'otp-secret');
          break;
        case 'custom':
          addCustom(draft, label, value, spec.customTypes?.[key]);
          if (spec.reportInferredCustom === true || spec.targets[key] === undefined) {
            log.countColumn(table.columns[position] ?? key);
          }
          break;
        case 'drop':
          droppedColumns.countColumn(table.columns[position] ?? key);
          break;
        case 'ignore':
          break;
      }
    });

    const record = finishDraft(draft);
    if (record === null) {
      log.add('skipped-row', `Line ${row.line} held no importable values.`, row.line);
      continue;
    }
    if (draft.title.trim() === '') {
      log.add(
        'derived-value',
        `Line ${row.line} had no title, so one was taken from its address or username.`,
        row.line
      );
    }
    folders.add(draft.folderPath);
    records.push(record);
  }

  log.flushColumns(
    'unmapped-column',
    (column, count) =>
      `Column "${column}" has no matching Keyhold field. It was kept as a custom field on ${count} record(s).`
  );
  droppedColumns.flushColumns('dropped-value', (column, count) => {
    const reason = spec.dropReasons?.[normaliseColumnKey(column)];
    const because = reason === undefined ? '' : ` ${reason}`;
    return `Column "${column}" was not imported on ${count} record(s).${because}`;
  });
  log.addAll(droppedColumns.all);

  return { records, warnings: log.all, folders: folders.all };
}

/** The first non-empty value among a set of candidate column names. */
export function firstValue(row: CsvRow, columns: readonly string[]): string {
  for (const column of columns) {
    const value = row.values.get(normaliseColumnKey(column));
    if (value !== undefined && value.trim() !== '') return value;
  }
  return '';
}
