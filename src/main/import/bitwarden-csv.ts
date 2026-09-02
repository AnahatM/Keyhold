// SPDX-License-Identifier: GPL-3.0-or-later
import { headerContains, readHeaderKeys } from './csv.js';
import { mapCsv, type CsvMappingSpec, type CsvRowContext } from './csv-mapper.js';
import { addCustom, guessCustomFieldType, type DraftRecord } from './mapping.js';
import type { ImportParser, ImportResult } from './types.js';

/**
 * Bitwarden's CSV export.
 *
 * Header, personal vault:
 * `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`
 *
 * An organisation export replaces `folder` with `collections`; both are handled.
 *
 * Two quirks carry real data and are the reason this file is not just a mapping table:
 *
 *  1. **`fields` packs every custom field into one cell** as newline-separated `name: value`
 *     pairs. The CSV export loses Bitwarden's field *type*, so the type is guessed here — and
 *     guessed towards secrecy, since a hidden field exported this way is indistinguishable
 *     from a visible one. The JSON export keeps the type; prefer it when offered the choice.
 *  2. **`login_uri` may hold several URIs**, newline-separated, which is why it maps to the
 *     `urls` array rather than to a single URL.
 */

const SPEC: CsvMappingSpec = {
  targets: {
    folder: 'folder',
    collections: 'folder',
    favorite: 'favorite',
    type: 'ignore', // consumed by the hook, which decides what the row becomes
    name: 'title',
    notes: 'notes',
    fields: 'ignore', // unpacked by the hook
    reprompt: 'drop',
    login_uri: 'url',
    login_username: 'username',
    login_password: 'password',
    login_totp: 'totp',
  },
  dropReasons: {
    reprompt: 'Bitwarden’s "ask for the master password again" flag has no Keyhold equivalent yet.',
  },
  hook: bitwardenHook,
};

function bitwardenHook(draft: DraftRecord, context: CsvRowContext): void {
  const type = context.value('type').trim().toLowerCase();
  if (type !== '' && type !== 'login' && type !== 'note') {
    context.warn(
      'unsupported-item',
      `Line ${context.row.line} is a Bitwarden "${type}" item. Its columns were imported as custom fields on a login record.`
    );
  }

  const fields = context.value('fields');
  if (fields !== '') {
    for (const [label, value] of parsePackedFields(fields)) {
      addCustom(draft, label, value, guessCustomFieldType(label, value));
    }
  }
  context.consume('fields');
}

/**
 * Unpacks `name: value` lines.
 *
 * A line with no colon is treated as a continuation of the previous value rather than as a
 * nameless field — that is what a multi-line custom field looks like once Bitwarden has
 * flattened it, and dropping those lines would silently truncate recovery-code blocks, which
 * is exactly the kind of field people put in there.
 */
export function parsePackedFields(cell: string): [string, string][] {
  const fields: [string, string][] = [];
  for (const line of cell.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const separator = line.indexOf(':');
    const last = fields[fields.length - 1];
    if (separator === -1) {
      if (last === undefined) {
        fields.push(['Field', line.trim()]);
        continue;
      }
      last[1] = `${last[1]}\n${line}`;
      continue;
    }
    fields.push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()]);
  }
  return fields;
}

export const bitwardenCsvParser: ImportParser = {
  id: 'bitwarden-csv',
  name: 'Bitwarden (CSV)',
  extensions: ['.csv'],
  description: 'Bitwarden’s unencrypted CSV export, personal or organisation.',
  needsMapping: false,

  detect(content: string): boolean {
    const keys = readHeaderKeys(content);
    return headerContains(keys, ['type', 'name', 'login_username', 'login_password']);
  },

  parse(content: string): ImportResult {
    return mapCsv(content, SPEC);
  },
};
