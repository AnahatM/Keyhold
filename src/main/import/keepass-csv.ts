// SPDX-License-Identifier: GPL-3.0-or-later
import { headerContains, headerMatchesAny, readHeaderKeys } from './csv.js';
import { mapCsv, type CsvMappingSpec } from './csv-mapper.js';
import type { ImportParser, ImportResult } from './types.js';

/**
 * The KeePass family's CSV export — KeePassXC's, and KeePass 2.x's older "KeePass CSV (1.x)".
 *
 * KeePassXC: `"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"`
 * KeePass 1.x-style: `"Account","Login Name","Password","Web Site","Comments"`
 *
 * **CSV is the wrong way to leave KeePass and this parser says so in the format list.** A
 * KDBX file keeps attachments, per-entry history, expiry dates, custom string fields and the
 * group tree; the CSV keeps none of that, and no importer can recover what the exporter did
 * not write. Phase 10 has KDBX 3 and 4 for exactly this reason. This exists for the person
 * who already has a CSV in hand.
 *
 * `Group` is a `/`-separated path whose first segment is the database's root group name, so
 * an import lands under a folder named after the source database. That is deliberate: it
 * keeps a KeePass import from scattering its groups across the top level of the vault.
 */

const KEEPASS_1X_HEADER = [['account', 'login name', 'password', 'web site', 'comments']];

const SPEC: CsvMappingSpec = {
  targets: {
    // KeePassXC
    group: 'folder',
    title: 'title',
    username: 'username',
    password: 'password',
    url: 'url',
    notes: 'notes',
    totp: 'totp',
    icon: 'drop',
    'last modified': 'drop',
    created: 'drop',
    // KeePass 1.x-style
    account: 'title',
    'login name': 'username',
    'web site': 'url',
    comments: 'notes',
  },
  dropReasons: {
    icon: 'It is a KeePass icon index, and Keyhold chooses icons for itself.',
    'last modified': 'Imported records are dated at the time of the import.',
    created: 'Imported records are dated at the time of the import.',
  },
};

export const keepassCsvParser: ImportParser = {
  id: 'keepass-csv',
  name: 'KeePass or KeePassXC (CSV)',
  extensions: ['.csv'],
  description: 'The KeePass CSV export. A KDBX file keeps far more — prefer it.',
  needsMapping: false,

  detect(content: string): boolean {
    const keys = readHeaderKeys(content);
    return (
      headerContains(keys, ['group', 'title', 'username', 'password', 'url']) ||
      headerMatchesAny(keys, KEEPASS_1X_HEADER)
    );
  },

  parse(content: string): ImportResult {
    return mapCsv(content, SPEC);
  },
};
