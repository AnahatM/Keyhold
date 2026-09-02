// SPDX-License-Identifier: GPL-3.0-or-later
import type { Credential, CustomField } from '@shared/model/credential.js';
import type { ExportFormatId } from '@shared/model/export.js';
import type { VaultDocument } from '@shared/model/vault-document.js';
import { writeCsv, type CsvWriteOptions } from './csv-writer.js';
import {
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
 * The leaving-Keyhold export: Bitwarden's CSV columns, which are the widest-supported target
 * there is.
 *
 * **A password manager you cannot leave is a trap.** This format exists so that "I want my
 * data somewhere else" has an answer that works on the first try, in the other product's own
 * importer, without the user editing a header row by hand. Bitwarden's column set is the one
 * to aim at: 1Password, Dashlane, NordPass, Proton Pass, KeePassXC and Bitwarden itself all
 * accept it or something that reads it, and Keyhold's own `bitwarden-csv` parser reads it
 * back — which is what `generic-csv.test.ts` asserts, rather than trusting the header text to
 * be right.
 *
 * ## The columns are exactly Bitwarden's, and that is the constraint
 *
 * `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`
 *
 * Adding a `tags` or `email` column would make the file more complete and less *accepted* —
 * a strict importer refuses an unrecognised header, and the whole point of this format is
 * that it goes in somewhere else without argument. So everything Keyhold has and Bitwarden
 * does not goes into `fields`, which is Bitwarden's own extension point for exactly this, and
 * is unpacked by every importer that understands the format. What still has no home is
 * dropped and named.
 *
 * ## Two mappings worth knowing about
 *
 *  - **`login_username` takes the username, or the email if there is no username.** Keyhold
 *    keeps the two apart and Bitwarden has one column; putting the email in when the username
 *    is empty is what makes the imported record usable, and when both exist the email is
 *    carried in `fields` rather than dropped.
 *  - **`login_totp` takes the first `otp-secret` custom field.** Keyhold has no first-class
 *    TOTP field — a seed lives in a typed custom field — and hoisting it into the column the
 *    other product expects is the difference between two-factor codes working after the move
 *    and the user re-enrolling every account by hand.
 */

const FORMAT: ExportFormatId = 'compatible-csv';
const EXTENSION = '.csv';

/** Bitwarden's personal-vault CSV header, in its own order. Do not add to this. */
export const COMPATIBLE_CSV_COLUMNS = [
  'folder',
  'favorite',
  'type',
  'name',
  'notes',
  'fields',
  'reprompt',
  'login_uri',
  'login_username',
  'login_password',
  'login_totp',
] as const;

export interface CompatibleCsvOptions extends ExportSelection {
  readonly csv?: CsvWriteOptions | undefined;
}

export function exportCompatibleCsv(
  document: VaultDocument,
  options: CompatibleCsvOptions = {}
): PlaintextExport {
  const selected = selectRecords(document, options);
  const losses = new LossLog();
  reportSelectionLosses(selected, losses);

  const rows = selected.records.map((record) => rowFor(document, record));
  const { text, neutralised } = writeCsv(COMPATIBLE_CSV_COLUMNS, rows, options.csv);

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
  const totp = totpField(record);

  return [
    folderPathOf(document.folders, record.folderId),
    flagCell(record.favorite),
    // Every Keyhold record is a login today, so this is a constant rather than a lie waiting
    // to be told. A future record type would need its own mapping here, not a default.
    'login',
    record.title,
    record.fields.notes,
    packLabelledValues(extraEntries(record, totp)),
    // Bitwarden's "ask for the master password again" flag. Keyhold has no equivalent, so
    // every record exports as "no" rather than inheriting a setting that does not exist.
    '0',
    joinUrls(record.fields.urls),
    loginUsername(record),
    record.fields.password,
    totp?.value ?? '',
  ];
}

/** The username column: the username, or the email when there is no username. */
function loginUsername(record: Credential): string {
  return record.fields.username === '' ? record.fields.email : record.fields.username;
}

/** The first one-time-password seed on the record, which the `login_totp` column takes. */
function totpField(record: Credential): CustomField | undefined {
  return record.fields.custom.find((field) => field.type === 'otp-secret');
}

/**
 * Everything Keyhold has that Bitwarden's columns do not, packed into `fields`.
 *
 * The order is fixed so the output is deterministic and so the same record always produces
 * the same cell: identity first, then the record's own fields, then its classification, then
 * its dates.
 */
function extraEntries(record: Credential, totp: CustomField | undefined): [string, string][] {
  const entries: [string, string][] = [];

  // Only when it is not already the username column — otherwise every imported record grows
  // a redundant "Email" field saying what `login_username` already says.
  if (record.fields.email !== '' && record.fields.email !== loginUsername(record)) {
    entries.push(['Email', record.fields.email]);
  }

  for (const field of record.fields.custom) {
    if (field.id === totp?.id) continue;
    entries.push([field.label, field.value]);
  }

  for (const question of record.fields.securityQuestions) {
    entries.push([question.question, question.answer]);
  }

  if (record.tags.length > 0) entries.push(['Tags', record.tags.join(', ')]);
  if (record.meta.expiresAt !== null) entries.push(['Expires', isoOrEmpty(record.meta.expiresAt)]);
  if (record.meta.rotationIntervalDays !== null) {
    entries.push(['Rotation interval (days)', String(record.meta.rotationIntervalDays)]);
  }

  return entries;
}

function reportFormatLosses(records: readonly Credential[], losses: LossLog): void {
  for (const record of records) {
    if (record.fields.email !== '' && record.fields.email !== loginUsername(record)) {
      losses.countRecord(
        'flattened',
        'email',
        (count) =>
          `${count} record(s) have both a username and an email. This format has one column for the two, so the email travels as a custom field named “Email”.`
      );
    }
    if (record.fields.securityQuestions.length > 0) {
      losses.countRecord(
        'flattened',
        'security questions',
        (count) =>
          `Security questions on ${count} record(s) travel as custom fields, one per question. The answers are all there; they are no longer marked as security answers.`
      );
    }
    if (record.tags.length > 0) {
      losses.countRecord(
        'flattened',
        'tags',
        (count) =>
          `This format has no tag column, so the tags on ${count} record(s) travel as a custom field named “Tags”.`
      );
    }
    if (record.trashedAt !== null) {
      losses.countRecord(
        'dropped',
        'trash state',
        (count) =>
          `${count} exported record(s) are in the Trash. This format cannot say so, and they will import as ordinary records.`
      );
    }
  }

  if (records.length > 0) {
    losses.add(
      'dropped',
      'dates',
      'Created, updated, last-used and password-changed dates have no column in this format. After importing elsewhere, every record will look as though it was created on the day it arrived.',
      records.length
    );
  }
}
