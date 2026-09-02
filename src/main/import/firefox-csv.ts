// SPDX-License-Identifier: GPL-3.0-or-later
import { headerContains, readHeaderKeys } from './csv.js';
import { mapCsv, type CsvMappingSpec } from './csv-mapper.js';
import type { ImportParser, ImportResult } from './types.js';

/**
 * Firefox's password export (`about:logins` → Export Logins).
 *
 * Header, all cells quoted:
 * `"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"`
 *
 * **There is no title column.** Every record's title is derived from its URL host, which is
 * why `deriveTitle` exists in the shared mapping layer rather than in one parser — a Firefox
 * import done without it produces a vault of entries all called "Untitled".
 *
 * The three timestamps are dropped rather than carried. `NewCredentialInput` has no way to
 * set `meta.createdAt` — `buildCredential` owns those, and it stamps "now" deliberately — so
 * carrying them would mean either lying about the model or inventing a second construction
 * path. They are reported by name instead, which is the honest version.
 */

const SPEC: CsvMappingSpec = {
  targets: {
    url: 'url',
    username: 'username',
    password: 'password',
    // Set only for HTTP-auth logins, and genuinely useful when it is: it names the realm the
    // credential belongs to. Left to the generic custom-field path, which reports it.
    guid: 'drop',
    timecreated: 'drop',
    timelastused: 'drop',
    timepasswordchanged: 'drop',
  },
  dropReasons: {
    guid: 'It is Firefox’s internal record id and means nothing outside Firefox.',
    timecreated: 'Imported records are dated at the time of the import.',
    timelastused: 'Imported records are dated at the time of the import.',
    timepasswordchanged: 'Imported records are dated at the time of the import.',
  },
};

export const firefoxCsvParser: ImportParser = {
  id: 'firefox-csv',
  name: 'Firefox (CSV)',
  extensions: ['.csv'],
  description: 'Firefox’s “Export Logins” CSV from about:logins.',
  needsMapping: false,

  detect(content: string): boolean {
    const keys = readHeaderKeys(content);
    return headerContains(keys, ['url', 'username', 'password', 'guid', 'timepasswordchanged']);
  },

  parse(content: string): ImportResult {
    return mapCsv(content, SPEC);
  },
};
