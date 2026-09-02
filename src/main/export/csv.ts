// SPDX-License-Identifier: GPL-3.0-or-later
import type { Credential, SecurityQuestion } from '@shared/model/credential.js';
import type { ExportFormatId } from '@shared/model/export.js';
import type { VaultDocument } from '@shared/model/vault-document.js';
import { writeCsv, type CsvWriteOptions } from './csv-writer.js';
import {
  customFieldEntries,
  flagCell,
  folderPathOf,
  isoOrEmpty,
  joinUrls,
  packLabelledValues,
  reportFlatLosses,
  reportNeutralisedCells,
} from './flat.js';
import { reportSelectionLosses, selectRecords, type ExportSelection } from './select.js';
import { LossLog, plaintextExport, type PlaintextExport } from './types.js';

/**
 * The Keyhold CSV: the vault as a spreadsheet.
 *
 * This is the format for **looking at** a vault — auditing it, sorting it by password age,
 * handing a filtered slice to someone who does not run Keyhold. It is not the format for
 * moving a vault, and it does not pretend to be: it drops history, it drops attachments, and
 * a record's identity is not in it, so importing it back creates new records rather than
 * updating the ones it came from. Every one of those is reported by name.
 *
 * The columns are the ones a person actually wants in a spreadsheet, including the dates the
 * health rules key off — `password_updated_at` is the column that makes "which of these are
 * ancient" answerable in Excel, which is a large part of why anyone exports a vault to a
 * spreadsheet at all.
 *
 * **Round trips go through Keyhold JSON, not through here.** Re-importing this file with the
 * "Any CSV" parser works and loses no *values*, but the packed cells arrive as one custom
 * field each rather than as the several fields they were, and the date columns arrive as
 * custom fields too. That is the honest cost of a flat file, and the reason the lossless
 * format exists beside it.
 */

const FORMAT: ExportFormatId = 'keyhold-csv';
const EXTENSION = '.csv';

/**
 * The column set. **The** column set — order is meaningful and every row is built from it.
 *
 * Named so the header is one list rather than a header array and a row builder that have to
 * agree. `csv.test.ts` asserts every row has exactly this many cells.
 */
export const KEYHOLD_CSV_COLUMNS = [
  'title',
  'username',
  'email',
  'password',
  'urls',
  'notes',
  'folder',
  'tags',
  'favorite',
  'custom_fields',
  'security_questions',
  'expires_at',
  'rotation_interval_days',
  'created_at',
  'updated_at',
  'password_updated_at',
  'last_used_at',
  'use_count',
  'trashed_at',
] as const;

export interface CsvExportOptions extends ExportSelection {
  readonly csv?: CsvWriteOptions | undefined;
}

export function exportCsv(
  document: VaultDocument,
  options: CsvExportOptions = {}
): PlaintextExport {
  const selected = selectRecords(document, options);
  const losses = new LossLog();
  reportSelectionLosses(selected, losses);

  const rows = selected.records.map((record) => rowFor(document, record));
  const { text, neutralised } = writeCsv(KEYHOLD_CSV_COLUMNS, rows, options.csv);

  reportFlatLosses(document, selected.records, losses);
  reportFormatLosses(selected.records, losses);
  losses.flush();
  reportNeutralisedCells(neutralised, losses);

  return plaintextExport({
    format: FORMAT,
    extension: EXTENSION,
    secretBytes: new Uint8Array(Buffer.from(text, 'utf8')),
    recordCount: selected.records.length,
    losses: losses.all,
  });
}

function rowFor(document: VaultDocument, record: Credential): string[] {
  return [
    record.title,
    record.fields.username,
    record.fields.email,
    record.fields.password,
    joinUrls(record.fields.urls),
    record.fields.notes,
    folderPathOf(document.folders, record.folderId),
    record.tags.join(', '),
    flagCell(record.favorite),
    packLabelledValues(customFieldEntries(record.fields.custom)),
    packLabelledValues(questionEntries(record.fields.securityQuestions)),
    isoOrEmpty(record.meta.expiresAt),
    record.meta.rotationIntervalDays === null ? '' : String(record.meta.rotationIntervalDays),
    isoOrEmpty(record.meta.createdAt),
    isoOrEmpty(record.meta.updatedAt),
    isoOrEmpty(record.meta.passwordUpdatedAt),
    isoOrEmpty(record.meta.lastUsedAt),
    String(record.meta.useCount),
    isoOrEmpty(record.trashedAt),
  ];
}

/**
 * Security questions as `question: answer`.
 *
 * The answer is a credential in every sense — it resets accounts — so it goes into the file
 * with the same weight as the password, not omitted for tidiness. What is lost is the pairing
 * being its own structure and the per-question id, which is reported.
 */
function questionEntries(questions: readonly SecurityQuestion[]): [string, string][] {
  return questions.map((question) => [question.question, question.answer]);
}

function reportFormatLosses(records: readonly Credential[], losses: LossLog): void {
  for (const record of records) {
    if (record.fields.securityQuestions.length > 0) {
      losses.countRecord(
        'flattened',
        'security questions',
        (count) =>
          `Security questions on ${count} record(s) were packed into one cell as “question: answer”. They read correctly, but they come back as ordinary custom fields rather than as security questions.`
      );
    }
    if (record.fields.urls.length > 1) {
      losses.countRecord(
        'flattened',
        'urls',
        (count) =>
          `${count} record(s) have more than one address. They share one cell, separated by line breaks — which Keyhold reads back correctly and some other tools do not.`
      );
    }
  }
}
