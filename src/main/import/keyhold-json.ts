// SPDX-License-Identifier: GPL-3.0-or-later
import {
  folderAncestors,
  importFolderId,
  importWarning,
  normaliseFolderPath,
  type ImportWarning,
} from '@shared/model/import.js';
import { KEYHOLD_JSON_FORMAT, parseKeyholdJson } from '../export/keyhold-json.js';
import type { NewCredentialInput } from '../vault/credential-ops.js';
import type { ImportParser, ImportResult } from './types.js';

/**
 * Reading Keyhold's own JSON export back in.
 *
 * This closes the round trip, and it is the only importer whose source format was written
 * by this app. That makes it the *lossless* path — everything the export carries, this
 * reads — and it is why the export exists at all: a password manager you cannot leave is a
 * trap, and one you cannot return to is barely better.
 *
 * ## It is a thin adapter, deliberately
 *
 * The reading and the hostile-input hardening all live in `src/main/export/keyhold-json.ts`,
 * beside the writer, because a reader that drifts from its writer is how a format quietly
 * stops round-tripping. This file's whole job is to present that reader as an
 * `ImportParser`, and to be honest about the two places the import pipeline is narrower
 * than the format.
 *
 * ## What the pipeline cannot carry, and why it is reported rather than silently dropped
 *
 * `NewCredentialInput` has no slot for identity, timestamps or history — `buildCredential`
 * owns all three, and it must, or an importer becomes a second definition of what a valid
 * record is. So a re-import creates *new* records with *new* ids and *fresh* history, and
 * this parser says so once rather than pretending otherwise.
 *
 * The consequence worth stating plainly: **importing an export is not a restore.** Restoring
 * a vault is copying the `.keep` file back, which is lossless by construction. This path is
 * for merging one vault's contents into another, and it behaves accordingly.
 */

const NO_HISTORY = 'History and its device/network origins';
const NO_IDENTITY = 'Record ids, created and updated dates';

function detect(content: string): boolean {
  // A cheap shape check, not a parse: this runs once per registered format for every file
  // the user picks. The format marker is near the top of the envelope, so a bounded slice
  // is enough and a 40 MB export is not read twice.
  return content.slice(0, 4_096).includes(`"${KEYHOLD_JSON_FORMAT}"`);
}

function parse(content: string): ImportResult {
  // Throws only when the file is not this format at all — which is the contract, and which
  // `parseKeyholdJson` already honours with messages that name the bad field's path and
  // never its value.
  const { document } = parseKeyholdJson(content);

  const warnings: ImportWarning[] = [];
  const folders = new Set<string>();

  /**
   * A folder's full path, walking parents.
   *
   * The `seen` set is not defensive tidiness: a folder tree read out of a file someone else
   * wrote can contain a cycle, and without it this loops forever inside a parse the user is
   * watching a spinner for.
   */
  const pathOf = (folderId: string): string | null => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let current: string | null = folderId;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const folder = document.folders.find((candidate) => candidate.id === current);
      if (folder === undefined) break;
      parts.unshift(folder.name);
      current = folder.parentId;
    }
    return normaliseFolderPath(parts.join('/'));
  };

  let carriedHistory = 0;
  const records: NewCredentialInput[] = [];

  for (const record of document.records) {
    // Trashed records are skipped rather than imported as live ones. Someone who deleted a
    // credential and then moved vaults has not asked for it back, and silently reviving it
    // is the kind of surprise that costs trust in an import.
    if (record.trashedAt !== null) continue;
    if (record.history.versions.length > 0) carriedHistory += 1;

    const input: NewCredentialInput = {
      title: record.title,
      action: 'import',
      username: record.fields.username,
      email: record.fields.email,
      password: record.fields.password,
      urls: record.fields.urls,
      notes: record.fields.notes,
      securityQuestions: record.fields.securityQuestions,
      custom: record.fields.custom,
      tags: record.tags,
      favorite: record.favorite,
    };

    const path = record.folderId === null ? null : pathOf(record.folderId);
    if (path !== null) {
      for (const ancestor of folderAncestors(path)) folders.add(ancestor);
      records.push({ ...input, folderId: importFolderId(path) });
      continue;
    }
    records.push(input);
  }

  const trashed = document.records.length - records.length;
  if (trashed > 0) {
    warnings.push(
      importWarning(
        'skipped-row',
        `${trashed} record${trashed === 1 ? '' : 's'} in the export's Trash ${trashed === 1 ? 'was' : 'were'} not imported.`
      )
    );
  }
  if (carriedHistory > 0) {
    warnings.push(
      importWarning(
        'dropped-value',
        `${NO_HISTORY}: ${carriedHistory} record${carriedHistory === 1 ? '' : 's'} carried version history. Imported records start a fresh one — copying the .keep file is the lossless route.`
      )
    );
  }
  if (document.records.length > 0) {
    warnings.push(
      importWarning(
        'dropped-value',
        `${NO_IDENTITY}: imported records get new ids and today's dates, so importing an export creates records rather than updating the ones it came from.`
      )
    );
  }
  if (document.tags.length > 0) {
    warnings.push(
      importWarning(
        'dropped-value',
        'Tag colours: tag names are kept, the colour each tag was given is not.'
      )
    );
  }

  // Ancestors first, so the caller can create them in order.
  const ordered = [...folders].sort((a, b) => a.split('/').length - b.split('/').length);
  return { records, warnings, folders: ordered };
}

export const keyholdJsonParser: ImportParser = {
  id: 'keyhold-json',
  name: 'Keyhold export (JSON)',
  extensions: ['.json'],
  description: "Keyhold's own export. The lossless route is copying the .keep file itself.",
  needsMapping: false,
  detect,
  parse,
};
