// SPDX-License-Identifier: GPL-3.0-or-later
import { importFolderId, type ColumnMapping, type ImportWarning } from '@shared/model/import.js';
import { importWarning } from '@shared/model/import.js';
import type {
  ImportDuplicateExisting,
  ImportFolderPlan,
  ImportMergeField,
  ImportSource,
  ParsedRecordLike,
} from '@shared/model/import-plan.js';
import { importMatchKey, previewRecord } from '@shared/model/import-plan.js';
import { FAKE_IMPORT_FORMATS, type FakeImportScenario } from './fake-gateway.js';

/**
 * The fixture the import tests are driven from.
 *
 * **Test support. Nothing in the app imports this.** It is not in `index.ts` for that reason.
 *
 * Its whole reason for existing is that the wizard's most important guarantee is a *negative*
 * one — no imported password, note body, security answer or TOTP seed ever reaches the
 * renderer — and a negative cannot be tested against a fixture that has nothing to leak. So
 * these records carry real secret material, spelled as sentinels that could not occur by
 * accident, and `ImportWizard.test.tsx` asserts that not one of them appears in any rendered
 * string or attribute of a fully-driven wizard.
 *
 * The secrets go in through `ParsedRecordLike`, which is exactly what a parser produces, and
 * they are projected by the real `previewRecord` — not by a test double that might be more
 * careful than the original.
 */

/**
 * Values that must never appear on screen.
 *
 * Deliberately unmistakable: a substring search for `hunter2` would collide with nothing in
 * this codebase, and a search for `KH-SECRET` collides with nothing anywhere. Each is long
 * enough that no CSS class, id or aria string could contain one by coincidence, so a hit is
 * always a real leak and never a false alarm.
 */
export const PLANTED_SECRETS = {
  googlePassword: 'KH-SECRET-google-hunter2',
  githubPassword: 'KH-SECRET-github-tr0ub4dor',
  netflixPassword: 'KH-SECRET-netflix-correcthorse',
  duplicatePassword: 'KH-SECRET-google-second-copy',
  noteBody: 'KH-SECRET-note-recovery-codes-8842',
  totpSeed: 'KH-SECRET-totp-JBSWY3DPEHPK3PXP',
  securityAnswer: 'KH-SECRET-answer-my-first-pet',
} as const;

/** Every planted secret, for the guard to sweep the DOM for. */
export const ALL_PLANTED_SECRETS: readonly string[] = Object.values(PLANTED_SECRETS);

/**
 * The parse: four records, two of which the match rule considers the same account.
 *
 * - **0 and 3 are the same Google account written twice.** Different case, a trailing space,
 *   a `www.` and a path on the second URL, and a differently-cased login — every difference
 *   that is *not* a difference. This is the within-file cluster, and it is what makes
 *   "importing a file with a duplicated row must not produce two records" assertable.
 * - **1 matches a record already in the vault** (see {@link EXISTING_RECORDS}), which is the
 *   other half of the same promise: importing the same export twice must not double.
 * - **2 matches nothing.** It is the control — a genuinely new record, which must survive
 *   every duplicate decision.
 */
export function plantedRecords(): readonly ParsedRecordLike[] {
  return [
    {
      title: 'Google',
      username: 'alice',
      email: 'alice@example.com',
      password: PLANTED_SECRETS.googlePassword,
      urls: ['https://google.com'],
      notes: PLANTED_SECRETS.noteBody,
      tags: ['personal'],
      folderId: importFolderId('Work'),
      favorite: true,
      custom: [
        {
          label: 'Authenticator',
          type: 'otp-secret',
          value: PLANTED_SECRETS.totpSeed,
          hidden: false,
        },
        {
          label: 'First pet',
          type: 'text',
          value: PLANTED_SECRETS.securityAnswer,
          hidden: true,
        },
        // Not secret, and therefore the one custom value that *is* expected on screen — so a
        // leak test cannot pass merely because the table renders no custom values at all.
        { label: 'Account number', type: 'text', value: 'AC-11924', hidden: false },
      ],
    },
    {
      title: 'GitHub',
      username: 'alice',
      password: PLANTED_SECRETS.githubPassword,
      urls: ['https://github.com/login'],
      folderId: importFolderId('Work'),
    },
    {
      title: 'Netflix',
      email: 'bob@example.com',
      password: PLANTED_SECRETS.netflixPassword,
      urls: ['netflix.com'],
    },
    {
      // The same account as record 0, written the way a second export writes it.
      title: '  google ',
      username: 'Alice',
      password: PLANTED_SECRETS.duplicatePassword,
      urls: ['https://www.google.com/accounts'],
    },
  ];
}

/** The one vault record the file collides with. */
export const EXISTING_RECORDS: readonly ImportDuplicateExisting[] = [
  {
    credentialId: 'cred-github',
    title: 'GitHub',
    username: 'alice',
    email: '',
    urls: ['https://github.com'],
    hasPassword: true,
    passwordLength: 18,
    updatedAt: 1_700_000_000_000,
  },
];

/**
 * What merging the GitHub group would do.
 *
 * `replaces` on the password on purpose: it is the single most expensive thing this screen
 * can do — overwrite a password in use with one out of an export of unknown age — and the
 * review step's danger note is gated on exactly this shape.
 */
export const MERGE_FIELDS: Readonly<Record<string, readonly ImportMergeField[]>> = {
  'cred-github': [
    { field: 'password', effect: 'replaces' },
    { field: 'urls', effect: 'adds' },
  ],
};

export const PLANTED_WARNINGS: readonly ImportWarning[] = [
  importWarning('dropped-value', 'Column could not be carried.', { column: 'Card number' }),
  importWarning('dropped-value', 'Column could not be carried.', { column: 'Expiry' }),
  importWarning('skipped-row', 'Row had nothing that could become a record.', { line: 14 }),
  importWarning('unmapped-column', 'Kept as a custom field.', { column: 'Reprompt' }),
  importWarning('derived-value', 'Title worked out from the web address.', { line: 3 }),
  importWarning('format', 'The header row carried a byte-order mark.'),
];

export const PLANTED_FOLDERS: readonly ImportFolderPlan[] = [
  { path: 'Work', willCreate: true, recordCount: 2 },
  { path: 'Personal', willCreate: false, recordCount: 0 },
];

export const PLANTED_SOURCE: ImportSource = {
  sourceId: 'source-1',
  fileName: 'bitwarden_export_20260902.csv',
  extension: '.csv',
  sizeBytes: 20_480,
  detectedFormatId: 'bitwarden-csv',
  candidateFormatIds: ['bitwarden-csv', 'lastpass-csv'],
  columns: ['name', 'login_username', 'login_password', 'login_uri', 'folder', 'notes'],
  inferredMapping: null,
};

/** A source the wizard must send through the mapping step. */
export const GENERIC_SOURCE: ImportSource = {
  ...PLANTED_SOURCE,
  detectedFormatId: 'generic-csv',
  candidateFormatIds: ['generic-csv'],
  inferredMapping: genericMapping(),
};

export function genericMapping(): ColumnMapping {
  return {
    columns: {
      name: 'title',
      login_username: 'username',
      login_password: 'password',
      login_uri: 'url',
      folder: 'folder',
      notes: 'notes',
    },
  };
}

/**
 * The scenario, with the planted parse behind it.
 *
 * Overrides are shallow and optional so a test can change exactly the one thing it is about
 * — an empty vault, a cancelled dialog — without restating six fields that are not the point
 * of it.
 */
export function plantedScenario(overrides: Partial<FakeImportScenario> = {}): FakeImportScenario {
  return {
    formats: FAKE_IMPORT_FORMATS,
    source: PLANTED_SOURCE,
    records: plantedRecords(),
    warnings: PLANTED_WARNINGS,
    folders: PLANTED_FOLDERS,
    existing: EXISTING_RECORDS,
    mergeFields: MERGE_FIELDS,
    cancelFileDialog: false,
    vaultGeneration: 7,
    ...overrides,
  };
}

/**
 * The vault as it would be *after* importing this file once.
 *
 * Built by running the same projection the preview runs and keying it the same way, which is
 * the honest way to state "the user already imported this": one entry per distinct account,
 * first row winning, exactly as `groupImportDuplicates` treats the vault side.
 *
 * This is what makes the second-import property real rather than a fixture that was hand-
 * written to agree with the matcher.
 */
export function vaultAfterImporting(
  records: readonly ParsedRecordLike[] = plantedRecords()
): readonly ImportDuplicateExisting[] {
  const byKey = new Map<string, ImportDuplicateExisting>();

  records.forEach((record, index) => {
    const projection = previewRecord(record, index);
    const key = importMatchKey(projection);
    if (byKey.has(key)) return;
    byKey.set(key, {
      credentialId: `cred-${String(index)}`,
      title: projection.title,
      username: projection.username,
      email: projection.email,
      urls: projection.urls,
      hasPassword: projection.hasPassword,
      passwordLength: projection.passwordLength,
      updatedAt: 1_700_000_000_000,
    });
  });

  return [...byKey.values()];
}
