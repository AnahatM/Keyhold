// SPDX-License-Identifier: GPL-3.0-or-later
import { importWarning, normaliseColumnKey, type ImportWarning } from '@shared/model/import.js';

/**
 * An RFC 4180 CSV reader, written by hand.
 *
 * ## Why by hand
 *
 * A CSV library in a password manager's trust boundary has to earn its place, and the
 * whole of RFC 4180 is the eighty lines below. Every byte of every export the user hands
 * us passes through here — including bytes an attacker chose, if the user was phished into
 * importing a crafted file — so "small enough to read in one sitting" is a security
 * property, not an aesthetic one.
 *
 * ## What real exports actually contain
 *
 * Each of these is a bug that has shipped in someone's importer:
 *
 *  - **A UTF-8 BOM.** Windows exports have one constantly. Ignored, it does not corrupt the
 *    data — it corrupts the *first column name*, so `name` becomes `<BOM>name`, matches
 *    nothing, and every title in the import silently comes out blank.
 *  - **Quoted fields containing the delimiter**, a newline, or a doubled `""`. A note field
 *    with a comma in it is the single most common shape in any export.
 *  - **Mixed line endings.** A file edited on two machines has both, sometimes on adjacent
 *    lines.
 *  - **A trailing newline, or none.** A naive split produces a phantom empty record from the
 *    first and loses the last record without it.
 *  - **Ragged rows.** Managers append columns between versions and do not always backfill.
 *    A short row must fill with empties, not shift every field left by one.
 *
 * The reader is deliberately **lenient**: it never throws. A malformed file still yields the
 * rows it could read, and the table layer turns the damage into warnings. Refusing an entire
 * export because line 400 has an unbalanced quote would be the worst possible outcome for a
 * user trying to leave another product.
 */

/** The character a UTF-8 BOM decodes to. */
const BOM = '\uFEFF';

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

export interface CsvParseOptions {
  /** Single character. Defaults to `,`. Tab-separated exports pass `\t`. */
  readonly delimiter?: string;
  /** Stop after this many rows. Detection reads one row and does not want the other 40,000. */
  readonly maxRows?: number;
}

export interface CsvRawRow {
  /** 1-based line in the source file where this row started. Quoted newlines are counted. */
  readonly line: number;
  readonly cells: readonly string[];
}

export interface CsvDocument {
  readonly rows: readonly CsvRawRow[];
  /** The file ended inside an open quote — the last row is whatever we could salvage. */
  readonly unterminatedQuote: boolean;
}

/**
 * Tokenises a CSV document into rows of raw cells.
 *
 * State is a single `inQuotes` flag plus `quotedField`, which exists to distinguish the two
 * kinds of quote character: one that *opens* a field, and one that appears mid-field and is
 * therefore literal text. Real exports contain `3" pipe` in a note, and treating that as an
 * opening quote would swallow the rest of the file.
 */
export function parseCsvRows(text: string, options: CsvParseOptions = {}): CsvDocument {
  const delimiter = options.delimiter ?? ',';
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  const source = stripBom(text);

  const rows: CsvRawRow[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  /** This field opened with a quote, so a later `""` is an escape rather than literal text. */
  let quotedField = false;
  let line = 1;
  let rowStartLine = 1;

  // `charAt` rather than indexing: it returns '' past the end, which keeps every lookahead
  // free of the `string | undefined` that `noUncheckedIndexedAccess` would otherwise force.
  const at = (index: number): string => source.charAt(index);

  const endRow = (): void => {
    cells.push(field);
    rows.push({ line: rowStartLine, cells });
    cells = [];
    field = '';
    quotedField = false;
  };

  let index = 0;
  for (; index < source.length; index += 1) {
    const char = at(index);

    if (inQuotes) {
      if (char === '"') {
        if (at(index + 1) === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
        continue;
      }
      // A newline inside quotes is data, but it is still a line for the purpose of telling
      // the user where a problem is.
      if (char === '\r') {
        if (at(index + 1) === '\n') index += 1;
        field += '\n';
        line += 1;
        continue;
      }
      if (char === '\n') {
        field += '\n';
        line += 1;
        continue;
      }
      field += char;
      continue;
    }

    if (char === '"') {
      if (field === '' && !quotedField) {
        inQuotes = true;
        quotedField = true;
      } else {
        field += char;
      }
      continue;
    }

    if (char === delimiter) {
      cells.push(field);
      field = '';
      quotedField = false;
      continue;
    }

    if (char === '\r' || char === '\n') {
      if (char === '\r' && at(index + 1) === '\n') index += 1;
      endRow();
      line += 1;
      rowStartLine = line;
      if (rows.length >= maxRows) return { rows, unterminatedQuote: false };
      continue;
    }

    field += char;
  }

  // A file that ends without a newline still has a final row. One that ends *with* a newline
  // does not — the reset in `endRow` leaves nothing behind, which is exactly the phantom
  // empty record a `split('\n')` implementation would invent here.
  if (cells.length > 0 || field !== '' || quotedField) {
    endRow();
  }

  return { rows, unterminatedQuote: inQuotes };
}

// ── The table view ───────────────────────────────────────────────────────────

export interface CsvRow {
  /** 1-based line in the source file. Quoted newlines are counted, so this points at the row. */
  readonly line: number;
  readonly cells: readonly string[];
  /** Normalised column key → cell value. Missing columns are absent, not empty. */
  readonly values: ReadonlyMap<string, string>;
}

export interface CsvTable {
  /** Header cells exactly as written, for display and for custom-field labels. */
  readonly columns: readonly string[];
  /** `columns` normalised for lookup — trimmed and lower-cased, in the same order. */
  readonly keys: readonly string[];
  readonly rows: readonly CsvRow[];
}

export interface CsvTableResult {
  readonly table: CsvTable;
  readonly warnings: readonly ImportWarning[];
}

/**
 * Turns a document into a header plus rows addressable by column name.
 *
 * Ragged rows are reported, never repaired silently. A row with fewer cells than the header
 * simply has fewer entries in its map — a missing column and an empty one are the same thing
 * to every caller, and pretending a short row had explicit empties would hide the damage.
 * A row with *more* cells keeps the extras in `cells`, so the mapper can still offer them.
 */
export function parseCsvTable(content: string, options: CsvParseOptions = {}): CsvTableResult {
  const document = parseCsvRows(content, options);
  const warnings: ImportWarning[] = [];

  if (document.unterminatedQuote) {
    warnings.push(
      importWarning(
        'format',
        'The file ends inside an unclosed quotation mark. The last row may be incomplete.'
      )
    );
  }

  const headerRow = document.rows[0];
  if (headerRow === undefined) {
    return { table: { columns: [], keys: [], rows: [] }, warnings };
  }

  const columns = headerRow.cells.map((cell) => cell.trim());
  const keys = columns.map((column) => normaliseColumnKey(column));

  const seen = new Set<string>();
  keys.forEach((key, position) => {
    if (key === '') return;
    if (seen.has(key)) {
      warnings.push(
        importWarning(
          'format',
          `The header names the column "${columns[position] ?? key}" more than once. Only the first is used.`,
          { column: columns[position] ?? key }
        )
      );
      return;
    }
    seen.add(key);
  });

  const rows: CsvRow[] = [];
  for (const raw of document.rows.slice(1)) {
    // A blank line reads as one empty cell. It is not a record and it is not damage.
    if (raw.cells.length === 1 && raw.cells[0] === '') continue;

    if (raw.cells.length !== keys.length) {
      warnings.push(
        importWarning(
          'ragged-row',
          `Line ${raw.line} has ${raw.cells.length} value(s) but the header declares ${keys.length}.`,
          { line: raw.line }
        )
      );
    }

    const values = new Map<string, string>();
    keys.forEach((key, position) => {
      if (key === '') return;
      if (values.has(key)) return; // duplicate header: first wins, already warned about
      const value = raw.cells[position];
      if (value === undefined) return;
      values.set(key, value);
    });

    rows.push({ line: raw.line, cells: raw.cells, values });
  }

  return { table: { columns, keys, rows }, warnings };
}

// ── Header inspection, for format detection ──────────────────────────────────

/** How much of a file `readHeaderKeys` will look at. A header past 64 KB is not a header. */
const HEADER_SCAN_BYTES = 64 * 1024;

/**
 * The normalised column keys of the first row, cheaply.
 *
 * `detect` runs for every registered format against every file the user picks, so it reads
 * one row from the front of the string rather than parsing a 40 MB export eleven times.
 */
export function readHeaderKeys(content: string): string[] {
  const document = parseCsvRows(content.slice(0, HEADER_SCAN_BYTES), { maxRows: 1 });
  const row = document.rows[0];
  if (row === undefined) return [];
  return row.cells.map((cell) => normaliseColumnKey(cell)).filter((key) => key !== '');
}

/**
 * True when the header is exactly one of the given column sets, order-insensitively.
 *
 * The cardinality is compared set-to-set, not `variant.length` to `actual.size`. Those two
 * differ the moment a variant repeats a column name: `['a', 'a']` has length 2 and names one
 * column, so it would false-match a header of `{a, b}` and detect a CSV as the wrong format.
 *
 * The second instance of this shape in the codebase. The first was in the merge engine, where
 * `sameIdSet` compared a list's length against a surviving-id set's size — and there it
 * silently dropped a healthy credential while emitting another twice. Here the variants come
 * from the static format registry rather than from a file, so it is a footgun rather than
 * something a hostile export can reach; it is fixed because the shape is wrong, and because
 * the next place it appears may not be the safe one either.
 */
export function headerMatchesAny(keys: readonly string[], variants: readonly string[][]): boolean {
  const actual = new Set(keys);
  return variants.some((variant) => {
    const wanted = new Set(variant);
    return wanted.size === actual.size && [...wanted].every((column) => actual.has(column));
  });
}

/** True when every required column is present and no forbidden one is. */
export function headerContains(
  keys: readonly string[],
  required: readonly string[],
  forbidden: readonly string[] = []
): boolean {
  const actual = new Set(keys);
  return (
    required.every((column) => actual.has(column)) &&
    !forbidden.some((column) => actual.has(column))
  );
}
