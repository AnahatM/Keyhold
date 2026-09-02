// SPDX-License-Identifier: GPL-3.0-or-later
import { headerContains, readHeaderKeys } from './csv.js';
import { mapCsv, type CsvMappingSpec, type CsvRowContext } from './csv-mapper.js';
import { addNote, type DraftRecord } from './mapping.js';
import type { ImportParser, ImportResult } from './types.js';

/**
 * LastPass's CSV export.
 *
 * Header: `url,username,password,totp,extra,name,grouping,fav`
 * Older exports omit `totp`; both are accepted.
 *
 * Two things about this format bite:
 *
 *  1. **`extra` is the notes field.** Named after nothing, and the single most commonly
 *     dropped column in third-party LastPass importers.
 *  2. **A secure note is a row whose `url` is the literal string `http://sn`.** Left alone
 *     that becomes a credential pointing at a hostname called "sn" — so the sentinel is
 *     recognised and the URL dropped rather than stored.
 *
 * `grouping` nests with a backslash (`Work\Clients`), which `normaliseFolderPath` handles
 * alongside the forward slash every other manager uses.
 */

/** LastPass writes this in the URL column of a secure note. It is not a URL. */
const SECURE_NOTE_URL = 'http://sn';

const SPEC: CsvMappingSpec = {
  targets: {
    url: 'url',
    username: 'username',
    password: 'password',
    totp: 'totp',
    extra: 'notes',
    name: 'title',
    grouping: 'folder',
    fav: 'favorite',
  },
  hook: lastpassHook,
};

function lastpassHook(draft: DraftRecord, context: CsvRowContext): void {
  const url = context.value('url').trim();
  if (url.toLowerCase() === SECURE_NOTE_URL) {
    // A secure note. Everything else about the row maps normally; only the sentinel goes.
    context.consume('url');
  }

  // LastPass writes a form-fill profile's fields into `extra` as `name:value` lines with a
  // leading marker. Keeping the block verbatim in notes is lossless and legible; splitting it
  // into custom fields would guess at a structure LastPass does not actually document.
  const extra = context.value('extra');
  if (extra.startsWith('NoteType:')) {
    addNote(draft, extra);
    context.consume('extra');
    context.warn(
      'unsupported-item',
      `Line ${context.row.line} is a LastPass structured note. Its fields were kept verbatim in the notes.`
    );
  }
}

export const lastpassCsvParser: ImportParser = {
  id: 'lastpass-csv',
  name: 'LastPass (CSV)',
  extensions: ['.csv'],
  description: 'LastPass’s unencrypted CSV export, including secure notes.',
  needsMapping: false,

  detect(content: string): boolean {
    const keys = readHeaderKeys(content);
    return headerContains(keys, ['url', 'username', 'password', 'extra', 'name', 'grouping']);
  },

  parse(content: string): ImportResult {
    return mapCsv(content, SPEC);
  },
};
