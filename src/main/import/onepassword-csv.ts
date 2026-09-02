// SPDX-License-Identifier: GPL-3.0-or-later
import { headerContains, readHeaderKeys } from './csv.js';
import { mapCsv, type CsvMappingSpec } from './csv-mapper.js';
import { isTruthy } from './mapping.js';
import type { ImportParser, ImportResult } from './types.js';

/**
 * 1Password 8's CSV export.
 *
 * Header: `Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes`
 *
 * **The CSV is 1Password's lossy export and should be the second choice.** It flattens every
 * item to a login: a Secure Note keeps only its text, and a Software Licence, a Credit Card
 * or an Identity loses its typed fields entirely — 1Password does not put them in the CSV at
 * all, so no importer can recover them. The 1PUX archive keeps everything, and Phase 10's
 * roadmap has it; this parser exists because the CSV is what the export menu offers first.
 *
 * `Archived` is honoured rather than ignored: an archived item is one the user has already
 * decided they are done with, and silently reviving it into their active list is a mess they
 * then have to clean up by hand.
 */

const SPEC: CsvMappingSpec = {
  targets: {
    title: 'title',
    url: 'url',
    urls: 'url',
    username: 'username',
    password: 'password',
    otpauth: 'totp',
    favorite: 'favorite',
    archived: 'ignore', // read by `skipRow` below, which decides the row's fate
    tags: 'tags',
    notes: 'notes',
    // 1Password 6's much older CSV used `Type`; harmless to accept and ignore.
    type: 'ignore',
  },
  skipRow: (context) =>
    isTruthy(context.value('archived')) ? 'it is archived in 1Password.' : null,
};

export const onePasswordCsvParser: ImportParser = {
  id: 'onepassword-csv',
  name: '1Password (CSV)',
  extensions: ['.csv'],
  description: '1Password 8’s CSV export. The 1PUX archive keeps more.',
  needsMapping: false,

  detect(content: string): boolean {
    const keys = readHeaderKeys(content);
    // `archived` is the column no other format here has, which is what separates this from
    // Safari's export — otherwise a superset of the same names.
    return headerContains(keys, ['title', 'url', 'username', 'password', 'archived']);
  },

  parse(content: string): ImportResult {
    return mapCsv(content, SPEC);
  },
};
