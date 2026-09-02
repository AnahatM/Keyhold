// SPDX-License-Identifier: GPL-3.0-or-later
import { headerContains, readHeaderKeys } from './csv.js';
import { mapCsv, type CsvMappingSpec } from './csv-mapper.js';
import type { ImportParser, ImportResult } from './types.js';

/**
 * Dashlane's `credentials.csv`.
 *
 * Header: `username,username2,username3,title,password,note,url,category,otpSecret`
 * Some builds emit `otpUrl` instead of, or as well as, `otpSecret`; both are accepted.
 *
 * **Dashlane exports several CSVs, not one.** A full export is a zip containing
 * `credentials.csv`, `securenotes.csv`, `payments.csv`, `ids.csv` and `personalinfo.csv`.
 * This parser handles the credentials file, which is the one holding logins. The others have
 * completely different headers and would need their own entries; until they exist, the
 * generic CSV parser can take them with a hand-made mapping.
 *
 * `username2` and `username3` are Dashlane's alternate logins for the same site — often an
 * email alias. They become custom fields rather than being merged into `username`: which one
 * a site actually wants is a fact only the user knows, and picking one silently would mean
 * the other two are gone.
 */

const SPEC: CsvMappingSpec = {
  targets: {
    username: 'username',
    username2: 'custom',
    username3: 'custom',
    title: 'title',
    password: 'password',
    note: 'notes',
    url: 'url',
    category: 'folder',
    otpsecret: 'totp',
    otpurl: 'totp',
  },
  customTypes: {
    // Dashlane's alternates are almost always email addresses, but not always — the guess
    // would land on 'email' for the common case and 'text' otherwise, which is right.
    username2: 'text',
    username3: 'text',
  },
  customLabels: {
    username2: 'Alternate login',
    username3: 'Alternate login 2',
  },
};

export const dashlaneCsvParser: ImportParser = {
  id: 'dashlane-csv',
  name: 'Dashlane (CSV)',
  extensions: ['.csv'],
  description: 'Dashlane’s credentials.csv, from the multi-file CSV export.',
  needsMapping: false,

  detect(content: string): boolean {
    const keys = readHeaderKeys(content);
    return headerContains(keys, ['username', 'username2', 'title', 'password', 'url']);
  },

  parse(content: string): ImportResult {
    return mapCsv(content, SPEC);
  },
};
