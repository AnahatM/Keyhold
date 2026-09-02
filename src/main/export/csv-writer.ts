// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * An RFC 4180 CSV writer, and the formula-injection defence.
 *
 * The mirror of `src/main/import/csv.ts`, written by hand for the same reason: every byte of
 * the user's vault passes through here on its way into a file other programs will open, and
 * "small enough to read in one sitting" is a security property.
 *
 * ## CSV injection is the reason this file is not four lines long
 *
 * Excel, LibreOffice and Google Sheets treat a cell beginning `=`, `+`, `-`, `@`, a tab or a
 * carriage return as a **formula**, not as text. A password manager that writes
 * `=cmd|'/c calc'!A0` into a spreadsheet has handed whoever opens that file a shell — and
 * the value came out of a credential store, so an attacker who can get one crafted record
 * into someone's vault (a shared entry, a phished import) can wait for the export.
 *
 * The standard mitigation is to prefix the cell with a single quote, which spreadsheets
 * consume as "the rest of this cell is text". Its cost is real and is stated plainly rather
 * than hidden:
 *
 *   **A neutralised value is no longer byte-identical to the value in the vault.** A password
 *   of `-hunter2` is written as `'-hunter2`. A spreadsheet shows `-hunter2`; a plain CSV
 *   reader, including Keyhold's own importer, sees the quote. So every neutralised cell is
 *   counted and reported as an `altered` loss, and the lossless JSON export never neutralises
 *   anything, because nothing opens it as a spreadsheet.
 *
 * Between "the export corrupts a handful of passwords, and says so" and "the export can run
 * code on the machine that opens it", the first is not close to being the worse trade. The
 * guard is still a setting (`formulaGuard`), because rule 7 says the user decides — someone
 * exporting to feed a script, not a spreadsheet, has a real reason to turn it off.
 *
 * ## The BOM
 *
 * A UTF-8 BOM is emitted by default. Without one, Excel on Windows opens a UTF-8 CSV as the
 * system ANSI code page and mangles every non-ASCII character in it — an exported password
 * containing `é` or `—` comes back wrong, which is silent data loss in the file whose entire
 * job is to carry data out. The cost is that a naive `split(',')` script sees the BOM glued
 * to the first column name and stops recognising it; Keyhold's own reader, and every
 * importer worth the name, strips it. That trade is worth making by default, and is a
 * setting for the scripts.
 */

/** The characters a spreadsheet treats as "this cell is a formula". */
export const FORMULA_TRIGGERS: readonly string[] = ['=', '+', '-', '@', '\t', '\r'];

/** What a neutralised cell is prefixed with. Consumed by spreadsheets, visible to everything else. */
export const FORMULA_GUARD_PREFIX = "'";

/** The character a UTF-8 BOM decodes to. Written as an escape so it is visible in a diff. */
export const BOM = '\uFEFF';

/** RFC 4180 says CRLF, and Excel on Windows is the consumer that cares. Our reader takes either. */
export const CSV_LINE_ENDING = '\r\n';

export interface CsvWriteOptions {
  /** Single character. Defaults to `,`. */
  readonly delimiter?: string | undefined;
  /** Emit a UTF-8 BOM. Defaults to `true` — see the note above. */
  readonly bom?: boolean | undefined;
  /** Neutralise leading formula characters. Defaults to `true`. */
  readonly formulaGuard?: boolean | undefined;
}

export interface NeutralisedColumn {
  readonly column: string;
  readonly cells: number;
}

export interface CsvWriteResult {
  readonly text: string;
  /**
   * Which columns had a cell neutralised, and how many, **in header order**.
   *
   * An array rather than a map so the order is the header's rather than an insertion
   * order that depends on which record happened to come first.
   */
  readonly neutralised: readonly NeutralisedColumn[];
}

/** True when a spreadsheet would try to evaluate this value. */
export function isFormula(value: string): boolean {
  // `charAt` rather than indexing: it returns '' past the end, which keeps this free of the
  // `string | undefined` that `noUncheckedIndexedAccess` would otherwise force.
  return FORMULA_TRIGGERS.includes(value.charAt(0));
}

/** Prefixes a formula-looking value so a spreadsheet reads it as text. */
export function neutraliseFormula(value: string): string {
  return isFormula(value) ? `${FORMULA_GUARD_PREFIX}${value}` : value;
}

/**
 * Quotes a cell if RFC 4180 requires it, doubling any embedded quote.
 *
 * Called **after** neutralisation, never before: a guard prefix added outside the quotes
 * would sit in the field separator's territory and every reader would disagree about what
 * the cell said.
 */
export function escapeCell(value: string, delimiter: string): string {
  const needsQuotes =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r');
  return needsQuotes ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * Writes a header and rows to CSV text.
 *
 * Deterministic by construction: it iterates the arrays it was given and touches no clock,
 * no `Set` and no `Object.keys`. The same header and rows always produce the same string.
 *
 * A row shorter than the header is padded with empty cells rather than shifting the
 * remaining values left — the failure mode a ragged row causes on the reading side is a
 * password appearing in the notes column, which is worse than an empty cell.
 */
export function writeCsv(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  options: CsvWriteOptions = {}
): CsvWriteResult {
  const delimiter = options.delimiter ?? ',';
  const guard = options.formulaGuard ?? true;

  const neutralisedCounts = header.map(() => 0);
  const lines: string[] = [header.map((cell) => escapeCell(cell, delimiter)).join(delimiter)];

  for (const row of rows) {
    const cells: string[] = [];
    for (let column = 0; column < header.length; column += 1) {
      const raw = row[column] ?? '';
      const guarded = guard ? neutraliseFormula(raw) : raw;
      if (guarded !== raw) neutralisedCounts[column] = (neutralisedCounts[column] ?? 0) + 1;
      cells.push(escapeCell(guarded, delimiter));
    }
    lines.push(cells.join(delimiter));
  }

  const neutralised: NeutralisedColumn[] = [];
  header.forEach((column, index) => {
    const cells = neutralisedCounts[index] ?? 0;
    if (cells > 0) neutralised.push({ column, cells });
  });

  // A trailing line ending, so appending to the file or concatenating two exports does not
  // fuse the last record of one onto the first of the next.
  const body = `${lines.join(CSV_LINE_ENDING)}${CSV_LINE_ENDING}`;
  return { text: `${(options.bom ?? true) ? BOM : ''}${body}`, neutralised };
}
