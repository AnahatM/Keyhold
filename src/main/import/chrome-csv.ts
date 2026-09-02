// SPDX-License-Identifier: GPL-3.0-or-later
import { headerMatchesAny, readHeaderKeys } from './csv.js';
import { mapCsv, type CsvMappingSpec } from './csv-mapper.js';
import type { ImportParser, ImportResult } from './types.js';

/**
 * Chrome's password export — **and Edge's, and Brave's, and every other Chromium browser's**.
 *
 * They share one implementation upstream, so they share one export format and one parser.
 * Registering three near-identical parsers would be rule 8's "second list" three times over,
 * and would make the format picker imply a difference that does not exist.
 *
 * Header: `name,url,username,password,note`
 * Chromium before ~M110 omitted `note`; both are accepted.
 *
 * `name` is the site's eTLD+1 as Chromium computed it, not a title the user chose — so it is
 * still the best title available, and it is what the user will recognise in the list.
 */

const HEADER_VARIANTS = [
  ['name', 'url', 'username', 'password', 'note'],
  ['name', 'url', 'username', 'password'],
];

const SPEC: CsvMappingSpec = {
  targets: {
    name: 'title',
    url: 'url',
    username: 'username',
    password: 'password',
    note: 'notes',
    notes: 'notes',
  },
};

export const chromeCsvParser: ImportParser = {
  id: 'chrome-csv',
  name: 'Chrome, Edge or Brave (CSV)',
  extensions: ['.csv'],
  description: 'The password export shared by every Chromium browser.',
  needsMapping: false,

  detect(content: string): boolean {
    // Exact-set matching, not "contains": NordPass's export starts with these same five
    // column names and then adds fourteen more. A `contains` check here would claim it.
    return headerMatchesAny(readHeaderKeys(content), HEADER_VARIANTS);
  },

  parse(content: string): ImportResult {
    return mapCsv(content, SPEC);
  },
};
