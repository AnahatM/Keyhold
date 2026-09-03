// SPDX-License-Identifier: GPL-3.0-or-later
import { VaultError } from '../crypto/errors.js';
import { headerContains, readHeaderKeys } from './csv.js';
import { mapCsv, type CsvMappingSpec, type CsvRowContext } from './csv-mapper.js';
import { addCustom, type DraftRecord } from './mapping.js';
import type { ImportParser, ImportResult } from './types.js';

/**
 * RoboForm's Logins CSV export.
 *
 * Header: `Url,Name,MatchUrl,Login,Pwd,Note,Folder`
 *
 * ## What is known and what is inferred
 *
 * **Known:** the seven column names above and their order, which is the shape this parser was
 * written against and the shape the fixture reproduces. `Pwd` is the load-bearing marker — no
 * other format in the registry spells the password column that way, which is what makes
 * detection unambiguous without having to match the whole header exactly.
 *
 * **Inferred, and stated as such rather than dressed up as documentation:**
 *
 *  - That some RoboForm builds append further columns for a passcard's individual form
 *    fields. Nothing here depends on it: an unrecognised column is carried as a custom field
 *    and reported by name, which is the engine's default and needs no special handling. If the
 *    guess is wrong, nothing has been built on it.
 *  - That a folder arrives as a `/`-rooted path (`/Personal/Communities`). The leading
 *    separator produces an empty first segment, which `normaliseFolderPath` already drops —
 *    so a build that writes `Personal\Communities` instead lands in the same place. This
 *    parser deliberately does **not** encode which one RoboForm uses, because it does not
 *    have to know.
 *  - That Safenotes and Identities are exported as separate files with different headers.
 *    Those go through the generic CSV parser with a hand-made mapping, exactly as Dashlane's
 *    non-credential files do. A note-shaped row *inside* this file — a title and a note, with
 *    no login — imports fine and is in the fixture.
 *
 * ## MatchUrl is not a second URL
 *
 * `MatchUrl` is RoboForm's *matching rule* for a passcard, not another address the account
 * lives at, and it may be a wildcard pattern (`https://*.example.org/*`). Mapping it to `url`
 * alongside `Url` would put that pattern in the record's URL list, where every future domain
 * match and every "open this site" affordance would then try to use it — a made-up address
 * arrived at by treating two different things as one.
 *
 * So it is kept as a field instead, and **only when it actually differs from `Url`**. In the
 * common case the two are identical and a "Match URL" field on every single record would be
 * pure noise; in the uncommon case the user's matching rule is genuinely information they
 * chose, and dropping it would be the silent loss this whole engine exists to prevent.
 */

/** Enough of the header to say "this is RoboForm" without demanding a version's exact columns. */
const DETECT_COLUMNS = ['url', 'name', 'login', 'pwd'];

/**
 * The columns without which the file cannot be read as RoboForm at all.
 *
 * Looser than `DETECT_COLUMNS` on purpose. Detection is a *suggestion* and should be shy;
 * `parse` runs because the user picked this format, possibly for a file detection did not
 * claim, and refusing it over a missing `Url` column would be the app overruling someone who
 * knows what their own export is.
 */
const REQUIRED_COLUMNS = ['name', 'login', 'pwd'];

const MATCH_URL_LABEL = 'Match URL';

const SPEC: CsvMappingSpec = {
  targets: {
    url: 'url',
    name: 'title',
    matchurl: 'ignore', // read by the hook, which decides whether it carries anything
    login: 'username',
    pwd: 'password',
    note: 'notes',
    notes: 'notes',
    folder: 'folder',
  },
  hook: roboformHook,
};

function roboformHook(draft: DraftRecord, context: CsvRowContext): void {
  const url = context.value('url');
  const matchUrl = context.value('matchurl');
  if (matchUrl === '' || sameAddress(url, matchUrl)) return;

  // Typed by the guesser rather than forced: the label contains "URL", so `guessCustomFieldType`
  // returns `url` for a real address and for a wildcard pattern alike. Forcing it here would be
  // a second place that decides what a URL-ish field is.
  addCustom(draft, MATCH_URL_LABEL, matchUrl);
}

/**
 * Whether two address cells are the same address for the purpose of "is this worth keeping?".
 *
 * Trimmed and case-folded, because a scheme and host are case-insensitive and RoboForm is not
 * consistent about the trailing whitespace. Deliberately *not* a URL normalisation: treating
 * `https://example.com` and `https://example.com/` as equal would need a parser, and getting
 * that wrong in the direction of "equal" silently discards the user's matching rule.
 */
function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export const roboformCsvParser: ImportParser = {
  id: 'roboform-csv',
  name: 'RoboForm (CSV)',
  extensions: ['.csv'],
  description: 'RoboForm’s Logins CSV export, including its folder paths.',
  needsMapping: false,

  detect(content: string): boolean {
    return headerContains(readHeaderKeys(content), DETECT_COLUMNS);
  },

  /**
   * Refuses a file whose header is not RoboForm's, rather than importing nothing from it.
   *
   * This is the failure that matters. Run through the generic mapping table, a foreign CSV
   * produces *something* — a pile of custom fields, or zero records and a warning nobody
   * reads — and the user concludes their data moved. It did not. An error naming the columns
   * that are missing, and pointing at the format that would have worked, is the only outcome
   * here that leaves them better off.
   *
   * The message names **columns**, never cells. A header is the user's own choice of label;
   * a cell is their password.
   */
  parse(content: string): ImportResult {
    const keys = readHeaderKeys(content);
    const missing = REQUIRED_COLUMNS.filter((column) => !keys.includes(column));
    if (missing.length > 0) {
      throw new VaultError(
        'MALFORMED',
        `This file is not a RoboForm CSV export. A RoboForm export begins with the columns ` +
          `Url, Name, MatchUrl, Login, Pwd, Note, Folder, and this file has no ` +
          `${missing.map((column) => `"${column}"`).join(' or ')} column. ` +
          `If it really is your RoboForm data, import it with “Any CSV file” and map the ` +
          `columns yourself.`
      );
    }
    return mapCsv(content, SPEC);
  },
};
