// SPDX-License-Identifier: GPL-3.0-or-later
import type { ImportFormatDescriptor } from '@shared/model/import.js';
import { bitwardenCsvParser } from './bitwarden-csv.js';
import { bitwardenJsonParser } from './bitwarden-json.js';
import { keyholdJsonParser } from './keyhold-json.js';
import { chromeCsvParser } from './chrome-csv.js';
import { dashlaneCsvParser } from './dashlane-csv.js';
import { firefoxCsvParser } from './firefox-csv.js';
import { genericCsvParser } from './generic-csv.js';
import { keepassCsvParser } from './keepass-csv.js';
import { lastpassCsvParser } from './lastpass-csv.js';
import { nordpassCsvParser } from './nordpass-csv.js';
import { onePasswordCsvParser } from './onepassword-csv.js';
import { safariCsvParser } from './safari-csv.js';
import { describeParser, type ImportParser } from './types.js';

/**
 * The format registry — **the** format registry.
 *
 * Rule 8: no second list. Every consumer reads this array. The file picker's filters, the
 * format dropdown, the auto-detection and the tests all derive from it, so adding a parser is
 * one import and one array entry, and there is no second place that can be forgotten.
 *
 * ## Order is significant
 *
 * `detectFormat` walks the array and takes the first parser that claims the file, so the
 * array runs **specific → general**. Several of these formats have overlapping headers —
 * Safari's columns are a subset of 1Password's, Chromium's first five are NordPass's first
 * five — and each parser's `detect` is written tightly enough to tell them apart, but the
 * ordering is the belt to that braces. `index.test.ts` asserts every fixture is claimed by
 * exactly one specific parser, which is what keeps the two consistent.
 */
export const PARSERS: readonly ImportParser[] = [
  // JSON first: it is decided by content shape, not by a header row, so it can never be
  // confused with a CSV. Keyhold's own format leads, because it is the only one whose
  // marker is unambiguous — everything else is inferred from a column set.
  keyholdJsonParser,
  bitwardenJsonParser,

  // CSVs with a column no other format has.
  bitwardenCsvParser,
  lastpassCsvParser,
  firefoxCsvParser,
  dashlaneCsvParser,
  nordpassCsvParser,
  keepassCsvParser,
  onePasswordCsvParser,

  // Exact-header formats, whose columns are subsets of the ones above.
  safariCsvParser,
  chromeCsvParser,

  // The catch-all. Claims any delimited file, so it must be last.
  genericCsvParser,
];

/** Every parser except the catch-all, which is only ever a fallback. */
export const SPECIFIC_PARSERS: readonly ImportParser[] = PARSERS.filter(
  (parser) => !parser.needsMapping
);

export function findParser(id: string): ImportParser | null {
  return PARSERS.find((parser) => parser.id === id) ?? null;
}

/** What the renderer gets: names and extensions, never a parser. */
export function importFormatDescriptors(): ImportFormatDescriptor[] {
  return PARSERS.map(describeParser);
}

/**
 * Suggests a format for a file.
 *
 * **A suggestion, never a decision.** The wizard shows the result pre-selected and the user
 * can change it, because a header row is weak evidence: two products can and do ship the same
 * columns, and a file the user renamed carries no evidence at all.
 *
 * The filename is used only to *rank* candidates, never to reject one. A `.txt` holding a
 * perfectly good Bitwarden CSV is still a Bitwarden CSV, and refusing it over its extension
 * would be the app being pedantic at the user's expense.
 */
export function detectFormat(filename: string, content: string): ImportParser | null {
  const extension = extensionOf(filename);
  const claimed = SPECIFIC_PARSERS.filter((parser) => safeDetect(parser, content));

  const byExtension = claimed.find((parser) => parser.extensions.includes(extension));
  if (byExtension !== undefined) return byExtension;
  const first = claimed[0];
  if (first !== undefined) return first;

  return safeDetect(genericCsvParser, content) ? genericCsvParser : null;
}

/** Every parser that claims the file, most specific first. For "did you mean…" in the wizard. */
export function detectFormats(filename: string, content: string): ImportParser[] {
  const extension = extensionOf(filename);
  const claimed = PARSERS.filter((parser) => safeDetect(parser, content));
  return [
    ...claimed.filter((parser) => parser.extensions.includes(extension)),
    ...claimed.filter((parser) => !parser.extensions.includes(extension)),
  ];
}

/**
 * `detect` is documented as never throwing, and this makes that true rather than trusted.
 *
 * A parser that throws on some pathological input would otherwise take down detection for
 * every other format at once — the user would see "could not read this file" for a file nine
 * other parsers would have handled.
 */
function safeDetect(parser: ImportParser, content: string): boolean {
  try {
    return parser.detect(content);
  } catch {
    return false;
  }
}

/** Lower-case, with the leading dot. `''` when the name has no extension. */
export function extensionOf(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

export { createGenericCsvParser, inferColumnMapping, readCsvColumns } from './generic-csv.js';
export { parseCsvRows, parseCsvTable, stripBom } from './csv.js';
export { describeParser, type ImportParser, type ImportResult } from './types.js';
