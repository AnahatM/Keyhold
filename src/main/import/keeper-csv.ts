// SPDX-License-Identifier: GPL-3.0-or-later
import {
  importWarning,
  normaliseColumnKey,
  normaliseFolderPath,
  type ImportWarning,
} from '@shared/model/import.js';
import { VaultError } from '../crypto/errors.js';
import {
  headerContains,
  parseCsvRows,
  readHeaderKeys,
  type CsvRawRow,
  type CsvRow,
  type CsvTable,
} from './csv.js';
import { mapCsvTable, type CsvMappingSpec, type CsvRowContext } from './csv-mapper.js';
import {
  addCustom,
  guessCustomFieldType,
  looksLikeUrl,
  WarningLog,
  type DraftRecord,
} from './mapping.js';
import type { ImportParser, ImportResult } from './types.js';

/**
 * Keeper's CSV export.
 *
 * Seven fixed columns, then custom fields as **trailing pairs of cells**:
 *
 * ```
 * Folder, Title, Login, Password, Website Address, Notes, Shared Folder,
 *   <field 1 name>, <field 1 value>, <field 2 name>, <field 2 value>, …
 * ```
 *
 * ## What is known and what is inferred
 *
 * **Known:** the seven-column order above and the trailing name/value pairs. That is Keeper's
 * documented CSV shape — it is what Keeper's own CSV *import* accepts, and its exporter round
 * -trips it. It is also the reason this parser cannot be a plain mapping table like the other
 * ten: a pair is addressed by *position*, and a header row cannot describe a structure whose
 * width changes from record to record.
 *
 * **Known:** that the headerless form exists and is the documented one.
 *
 * **Inferred, and said plainly rather than presented as documentation:**
 *
 *  - That some builds write a header row and some do not. This parser accepts both because
 *    the cost of being wrong in either direction is a user whose import produces nothing —
 *    not because a specific version has been confirmed to do either.
 *  - The exact header *text* of a headed export. `Website Address` is the documented field
 *    name, but `Web Address`, `Url` and `Login URL` are accepted as synonyms, and `Login` is
 *    accepted alongside `Username`. Guessing a synonym costs nothing; guessing wrong and
 *    matching nothing costs the user their URLs.
 *  - That TOTP arrives as one of the trailing pairs rather than as an eighth fixed column.
 *    **Nothing depends on that guess**: an `otpauth://` value is recognised by
 *    `guessCustomFieldType` from its own shape whatever the pair is named, so the seed lands
 *    in an `otp-secret` field — and therefore out of the renderer — without this file having
 *    to know what Keeper calls the column.
 *
 * ## Why this parser builds its own table
 *
 * `parseCsvTable` treats row one as the header, which is exactly wrong for a headerless file:
 * it would eat the first record. The obvious repair — splice a synthetic header line onto the
 * front of the text and hand it back to `parseCsvTable` — is worse than it looks, because
 * every line number in every warning would then be one too high, and a warning that points at
 * the wrong line is a warning that sends the user looking in the wrong place. So the rows are
 * tokenised with `parseCsvRows` and the table is assembled here, with the real line numbers
 * intact, and the mapping is still done by the shared `mapCsvTable`.
 *
 * The same assembly is what keeps the pair columns out of the generic column pass: the table's
 * keys stop at the seventh column no matter how wide the header is, so a header cell like
 * `Custom Field 1 Name` never becomes a field whose *value* is the name of a field.
 */

/** The documented fixed columns, in order. Used verbatim as the header of a headerless file. */
const KEEPER_COLUMNS = [
  'Folder',
  'Title',
  'Login',
  'Password',
  'Website Address',
  'Notes',
  'Shared Folder',
] as const;

/** The three column names a headed Keeper export cannot be missing. */
const HEADER_MARKERS = ['title', 'login', 'password'];

/** Any one of these in a header means "the address column is present", whatever it is called. */
const ADDRESS_COLUMNS = new Set(['website address', 'web address', 'url', 'login url']);

/** Any one of these means "the folder column is present". */
const FOLDER_COLUMNS = new Set(['folder', 'shared folder']);

const SHARED_FOLDER_LABEL = 'Keeper shared folder';
const UNNAMED_FIELD_LABEL = 'Unnamed Keeper field';

/** How far into a file the headerless heuristic will look, and how many rows it will judge. */
const SCAN_BYTES = 64 * 1024;
const SCAN_ROWS = 5;

/**
 * Column names that mean "row one of this file is a header row".
 *
 * The headerless heuristic's whole job is telling a header apart from a record, and it has no
 * positive evidence to work from — a headerless seven-column CSV looks like any other
 * headerless seven-column CSV. So the negative evidence carries the weight: every export
 * format in this registry names at least one of these in its header, and a Keeper *record*
 * whose folder is literally called "password" is not a case worth designing for.
 */
const HEADER_WORDS = new Set([
  '2fa',
  'account',
  'category',
  'collection',
  'collections',
  'comment',
  'comments',
  'email',
  'entry',
  'fav',
  'favorite',
  'favourite',
  'folder',
  'group',
  'grouping',
  'guid',
  'login',
  'login name',
  'name',
  'note',
  'notes',
  'otpauth',
  'password',
  'pwd',
  'secret',
  'site',
  'tags',
  'title',
  'totp',
  'type',
  'uri',
  'url',
  'urls',
  'user',
  'username',
  'web site',
  'website',
]);

const SPEC_TARGETS: CsvMappingSpec['targets'] = {
  folder: 'folder',
  title: 'title',
  login: 'username',
  username: 'username',
  password: 'password',
  'website address': 'url',
  'web address': 'url',
  url: 'url',
  'login url': 'url',
  notes: 'notes',
  note: 'notes',
  // Also `folder`, so a record that lives only in a shared folder still lands somewhere. The
  // engine's `??=` means the personal folder wins when both are set, and the hook below makes
  // sure the shared one is not silently dropped when it loses that race.
  'shared folder': 'folder',
};

// ── Reading a row ────────────────────────────────────────────────────────────

/**
 * Handles everything about a Keeper row that is positional rather than named.
 *
 * `fixedCount` is the table's own width rather than `KEEPER_COLUMNS.length`, because a headed
 * export that stops at `Notes` has six fixed columns and its pairs start one cell earlier.
 * Hard-coding seven here would read that file's first pair name out of its notes column.
 */
function keeperHook(draft: DraftRecord, context: CsvRowContext, fixedCount: number): void {
  const cells = context.row.cells;

  if (cells.length < fixedCount) {
    context.warn(
      'ragged-row',
      `Line ${context.row.line} has ${cells.length} value(s), but a Keeper record has ${fixedCount} before its custom fields. The missing ones were left empty.`
    );
  }

  carrySharedFolder(draft, context);
  carryCustomPairs(draft, context, cells.slice(fixedCount));
}

/**
 * Keeps the shared folder's name when the personal folder has already claimed `folderPath`.
 *
 * Keyhold has no sharing, so a shared folder cannot be modelled as one — but it is still the
 * name of the place the user kept this record, and a record that was in both would otherwise
 * lose one of them without a word. No warning is raised because **nothing was lost**: the
 * value is on the record, under a label that says where it came from.
 */
function carrySharedFolder(draft: DraftRecord, context: CsvRowContext): void {
  const folder = context.value('folder');
  const shared = context.value('shared folder');
  if (folder === '' || shared === '') return;
  if (normaliseFolderPath(folder) === normaliseFolderPath(shared)) {
    context.consume('shared folder');
    return;
  }
  addCustom(draft, SHARED_FOLDER_LABEL, shared, 'text');
  context.consume('shared folder');
}

/**
 * Unpacks the trailing `name, value` cells.
 *
 * Two shapes get a value they cannot name, and both are resolved **towards secrecy**:
 *
 *  - a pair whose name cell is blank, and
 *  - a trailing odd cell, where the export was truncated mid-pair.
 *
 * Either could be a display name or a recovery key and there is no way to tell. The type
 * guesser reads the label, so with no label it would fall back on the value's shape and return
 * `text` for most secrets — which puts them in the safe projection, where the renderer can see
 * them (decision D13). Forcing `password` instead costs one click to reveal a value that turns
 * out to be innocuous, and prevents a leak when it is not. Those two errors are not the same
 * size, which is the same reasoning `nordpass-csv.ts` applies to a card number.
 */
function carryCustomPairs(
  draft: DraftRecord,
  context: CsvRowContext,
  extras: readonly string[]
): void {
  for (let index = 0; index + 1 < extras.length; index += 2) {
    const label = extras[index] ?? '';
    const value = extras[index + 1] ?? '';
    if (value.trim() === '') continue;
    if (label.trim() === '') {
      addCustom(draft, `${UNNAMED_FIELD_LABEL} ${index / 2 + 1}`, value, 'password');
      continue;
    }
    addCustom(draft, label, value, guessCustomFieldType(label, value));
  }

  if (extras.length % 2 === 0) return;

  const orphan = extras[extras.length - 1] ?? '';
  context.warn(
    'ragged-row',
    `Line ${context.row.line} ends with an unpaired custom-field cell. Keeper writes custom fields as a name and a value; this row has a name or a value without its partner.`
  );
  if (orphan.trim() === '') return;
  addCustom(draft, `${UNNAMED_FIELD_LABEL} ${Math.ceil(extras.length / 2)}`, orphan, 'password');
}

// ── Building the table ───────────────────────────────────────────────────────

/** A blank line reads as one empty cell. It is not a record and it is not damage. */
function isBlankRow(raw: CsvRawRow): boolean {
  return raw.cells.length === 1 && raw.cells[0] === '';
}

/** True when a header cell past the seventh is one of Keeper's own pair-slot labels. */
function looksLikePairHeader(name: string): boolean {
  const key = normaliseColumnKey(name);
  return key === '' || /custom|field|name|value/.test(key);
}

interface KeeperTable {
  readonly table: CsvTable;
  readonly warnings: readonly ImportWarning[];
  /** True when row one was consumed as a header rather than read as a record. */
  readonly headed: boolean;
}

/**
 * Assembles the fixed columns into a table, leaving the pair cells in `CsvRow.cells`.
 *
 * `keys` deliberately stops at the fixed columns. `mapCsvTable` iterates `keys`, so anything
 * past them is invisible to the generic column pass and reachable only through the hook —
 * which is precisely the separation the format needs.
 */
function buildKeeperTable(content: string): KeeperTable {
  const document = parseCsvRows(content);
  const warnings: ImportWarning[] = [];

  if (document.unterminatedQuote) {
    warnings.push(
      importWarning(
        'format',
        'The file ends inside an unclosed quotation mark. The last row may be incomplete.'
      )
    );
  }

  const body = document.rows.filter((raw) => !isBlankRow(raw));
  const first = body[0];
  const headed = first !== undefined && isKeeperHeader(first.cells);

  // A headerless file borrows Keeper's documented column names, so warnings and custom-field
  // labels read the same whichever shape the export arrived in.
  const headerCells: readonly string[] = headed ? first.cells : KEEPER_COLUMNS;
  const columns = headerCells.slice(0, KEEPER_COLUMNS.length).map((cell) => cell.trim());
  const keys = columns.map((column) => normaliseColumnKey(column));

  if (headed) {
    const extras = headerCells.slice(KEEPER_COLUMNS.length);
    if (extras.length > 0 && !extras.every(looksLikePairHeader)) {
      warnings.push(
        importWarning(
          'format',
          `The header declares ${extras.length} column(s) beyond the seven a Keeper record has. They were read as Keeper's custom-field name and value pairs, which is what that part of the row is in a Keeper export.`
        )
      );
    }
  }

  const rows: CsvRow[] = (headed ? body.slice(1) : body).map((raw) => ({
    line: raw.line,
    cells: raw.cells,
    values: valuesOf(keys, raw.cells),
  }));

  return { table: { columns, keys, rows }, warnings, headed };
}

function valuesOf(keys: readonly string[], cells: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  keys.forEach((key, position) => {
    if (key === '' || values.has(key)) return;
    const value = cells[position];
    if (value === undefined) return;
    values.set(key, value);
  });
  return values;
}

// ── Recognising the shape ────────────────────────────────────────────────────

/** True when these cells are a Keeper header rather than a Keeper record. */
function isKeeperHeader(cells: readonly string[]): boolean {
  return headerContains(
    cells.map((cell) => normaliseColumnKey(cell)),
    HEADER_MARKERS
  );
}

/**
 * The headerless heuristic, kept deliberately shy.
 *
 * It runs only in `detect`, which *suggests* a format. `parse` accepts far less evidence,
 * because by then the user has chosen this format for this file and the app has no business
 * second-guessing them. Being shy here means a headerless export whose first rows have no
 * website address is not auto-suggested — the user picks "Keeper (CSV)" from the list and it
 * imports correctly. Being generous here would mean claiming somebody else's file and reading
 * their columns in Keeper's order, which produces plausible, wrong records and no error at all.
 */
function looksHeaderless(content: string): boolean {
  const window = content.slice(0, SCAN_BYTES);
  const document = parseCsvRows(window, { maxRows: SCAN_ROWS + 1 });
  let rows = document.rows.filter((raw) => !isBlankRow(raw));
  // The window may have cut the final row in half, which would make it look short.
  if (window.length < content.length && rows.length > 1) rows = rows.slice(0, -1);
  rows = rows.slice(0, SCAN_ROWS);

  const first = rows[0];
  if (first === undefined) return false;
  if (first.cells.some((cell) => HEADER_WORDS.has(normaliseColumnKey(cell)))) return false;

  const fixed = KEEPER_COLUMNS.length;
  for (const row of rows) {
    if (row.cells.length < fixed) return false;
    if ((row.cells.length - fixed) % 2 !== 0) return false;
  }

  // The one piece of positive evidence available: column five is a website address.
  const address = KEEPER_COLUMNS.indexOf('Website Address');
  return rows.some((row) => looksLikeUrl(row.cells[address] ?? ''));
}

export const keeperCsvParser: ImportParser = {
  id: 'keeper-csv',
  name: 'Keeper (CSV)',
  extensions: ['.csv'],
  description: 'Keeper’s CSV export, with or without a header row, custom fields included.',
  needsMapping: false,

  detect(content: string): boolean {
    // A binary file tokenises into one wide row of mojibake, which the headerless heuristic
    // would otherwise have to reason about. `generic-csv.ts` filters the same way.
    if (content.includes('\0')) return false;

    const keys = readHeaderKeys(content);
    const headed =
      headerContains(keys, HEADER_MARKERS) &&
      keys.some((key) => ADDRESS_COLUMNS.has(key)) &&
      keys.some((key) => FOLDER_COLUMNS.has(key));

    return headed || looksHeaderless(content);
  },

  /**
   * Refuses a file that is neither shape, rather than importing nothing from it.
   *
   * A Keeper export is defined by its *positions*, so a foreign CSV run through this parser
   * would not fail — it would succeed at reading somebody else's columns as Keeper's, and hand
   * back records whose password field holds whatever their fourth column happened to be. An
   * empty or wrong import that reports success is the worst outcome available here, because
   * the user believes their data moved and deletes the source.
   *
   * **The threshold is a majority of rows, not all of them, and that is the whole design.**
   * "Every row must fit" would refuse a 3,000-record export over one truncated line, which is
   * the failure this engine exists to avoid; "any row may fit" would accept a foreign file on
   * the strength of one coincidence. A file where most rows do not fit Keeper's widths is not
   * a damaged Keeper export, it is a different format.
   *
   * What this cannot do is tell a headerless Keeper export from *any other* headerless
   * seven-column CSV, because nothing in either file distinguishes them. That limit is real
   * and is stated here rather than papered over: the user chose this format for this file, and
   * a wrong choice shows up in the dry-run preview, which is what the preview is for.
   *
   * The message names **columns and counts**, never cells.
   */
  parse(content: string): ImportResult {
    const { table, warnings, headed } = buildKeeperTable(content);
    const fixedCount = table.keys.length;
    const widths = table.rows.map((row) => row.cells.length);
    const usable = widths.filter((width) => isKeeperWidth(width, fixedCount)).length;

    if (!headed && widths.length > 0 && usable * 2 < widths.length) {
      throw new VaultError(
        'MALFORMED',
        `This file is not a Keeper CSV export. A Keeper export either starts with the columns ` +
          `Folder, Title, Login, Password, Website Address, Notes, Shared Folder, or has no ` +
          `header row at all and ${KEEPER_COLUMNS.length} columns in that order followed by ` +
          `pairs of custom-field name and value cells. This file has neither: its rows are ` +
          `${describeWidths(widths)}. If it really is your Keeper data, import it with ` +
          `“Any CSV file” and map the columns yourself.`
      );
    }

    const log = new WarningLog();
    log.addAll(warnings);
    if (widths.length === 0 && !headed) {
      // Mirrors `mapCsv`'s wording for the same case, which this parser cannot reach through
      // it: `buildKeeperTable` always has seven column names, so "no columns" never happens.
      log.add('format', 'The file is empty — there is not even a header row.');
    }

    const spec: CsvMappingSpec = {
      targets: SPEC_TARGETS,
      hook: (draft, context) => {
        keeperHook(draft, context, fixedCount);
      },
    };
    return mapCsvTable(table, spec, log);
  },
};

/** A row wide enough for the fixed columns, with its custom-field cells in whole pairs. */
function isKeeperWidth(width: number, fixedCount: number): boolean {
  return width >= fixedCount && (width - fixedCount) % 2 === 0;
}

/** Row widths as a phrase. Counts only — a width is not content. */
function describeWidths(widths: readonly number[]): string {
  if (widths.length === 0) return 'empty';
  const distinct = [...new Set(widths)].sort((a, b) => a - b);
  const listed = distinct.slice(0, 4).join(', ');
  const suffix = distinct.length > 4 ? ', …' : '';
  return `${listed}${suffix} cell(s) wide`;
}
