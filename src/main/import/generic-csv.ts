// SPDX-License-Identifier: GPL-3.0-or-later
import {
  normaliseColumnKey,
  type ColumnMapping,
  type ImportFieldTarget,
} from '@shared/model/import.js';
import { isSingleValuedImportTarget } from '@shared/model/import-plan.js';
import { parseCsvTable, readHeaderKeys } from './csv.js';
import { mapCsv, mapCsvTable, type CsvMappingSpec } from './csv-mapper.js';
import { WarningLog } from './mapping.js';
import type { ImportParser, ImportResult } from './types.js';

/**
 * The catch-all: a CSV parsed through a column mapping the user supplies.
 *
 * **This is the most important parser in the registry.** Ten named formats cover the managers
 * people are most likely to be leaving; this one covers every manager that exists. A niche
 * tool, a corporate password spreadsheet, a script someone wrote in 2014 — all of them export
 * *some* CSV, and none of them will ever get a dedicated parser. Without this, "can I get my
 * data in?" has ten yes answers and an unbounded number of no answers.
 *
 * It is also the parser the mapping UI drives. `inferColumnMapping` produces the pre-filled
 * dropdowns from the file's own header, the user corrects whatever the guess got wrong, and
 * `createGenericCsvParser` turns their corrected mapping into a parser. The registry entry
 * below is the same thing with nobody having corrected anything — useful on its own, since
 * the inference gets most well-behaved exports right unaided.
 */

// ── Inference ────────────────────────────────────────────────────────────────

/**
 * Column names seen in the wild, grouped by where they belong.
 *
 * Names only, no patterns. A regular expression here would match `password hint` as a
 * password and `email verified` as an email — the long tail of near-misses is worse than the
 * handful of exact names it would have caught, and this table is what the UI shows the user
 * as a starting point rather than a final answer.
 */
const COLUMN_SYNONYMS: Readonly<Record<ImportFieldTarget, readonly string[]>> = {
  title: ['title', 'name', 'account', 'entry', 'item', 'display name', 'label', 'service'],
  username: [
    'username',
    'user name',
    'user',
    'login',
    'login name',
    'loginname',
    'userid',
    'user id',
    'account name',
    'login_username',
  ],
  email: ['email', 'e-mail', 'e mail', 'email address', 'mail'],
  password: ['password', 'passwd', 'pwd', 'pass', 'login_password', 'secret'],
  url: [
    'url',
    'urls',
    'uri',
    'website',
    'web site',
    'site',
    'link',
    'login_uri',
    'web address',
    'hostname',
    'host',
  ],
  notes: ['notes', 'note', 'comment', 'comments', 'extra', 'memo', 'description', 'free text'],
  folder: ['folder', 'group', 'grouping', 'category', 'collection', 'collections', 'path', 'vault'],
  tags: ['tags', 'tag', 'labels', 'keywords'],
  favorite: ['favorite', 'favourite', 'fav', 'starred', 'is favorite', 'is favourite'],
  totp: [
    'totp',
    'otp',
    'otpauth',
    'otpsecret',
    'otp secret',
    'otpurl',
    'otp url',
    '2fa',
    'two factor',
    'authenticator',
    'login_totp',
    'totp secret',
  ],
  // Never inferred — a column reaches these only because the user chose them.
  custom: [],
  drop: [],
  ignore: [],
};

/** Reverse index, built once. Two synonym lists claiming the same name would be a bug. */
const SYNONYM_INDEX: ReadonlyMap<string, ImportFieldTarget> = buildSynonymIndex();

function buildSynonymIndex(): Map<string, ImportFieldTarget> {
  const index = new Map<string, ImportFieldTarget>();
  for (const [target, names] of Object.entries(COLUMN_SYNONYMS)) {
    for (const name of names) {
      // First writer wins, and the guard test asserts there is never a second one.
      if (!index.has(name)) index.set(name, target as ImportFieldTarget);
    }
  }
  return index;
}

/** Exported so the registry test can assert no synonym is claimed by two targets. */
export function synonymCollisions(): string[] {
  const seen = new Map<string, ImportFieldTarget>();
  const collisions: string[] = [];
  for (const [target, names] of Object.entries(COLUMN_SYNONYMS)) {
    for (const name of names) {
      const existing = seen.get(name);
      if (existing !== undefined && existing !== target) collisions.push(name);
      else seen.set(name, target as ImportFieldTarget);
    }
  }
  return collisions;
}

/**
 * Guesses a mapping from a header row.
 *
 * Anything unrecognised maps to `custom`, never to `drop`. The difference matters: a wrong
 * guess towards `custom` costs the user one dropdown change, while a wrong guess towards
 * `drop` costs them a column they may not notice is missing until the old manager is gone.
 */
export function inferColumnMapping(columns: readonly string[]): ColumnMapping {
  const mapped: Record<string, ImportFieldTarget> = {};
  const claimed = new Set<ImportFieldTarget>();

  for (const column of columns) {
    const key = normaliseColumnKey(column);
    if (key === '') continue;
    const target = SYNONYM_INDEX.get(key);
    // Single-valued targets are claimed once. A file with both `name` and `title` should not
    // have the second one overwrite the first — it should become a custom field and be
    // reported, so the user sees that a decision was made on their behalf.
    //
    // `isSingleValuedImportTarget` comes from `@shared/model/import-plan.ts`. This file used
    // to carry its own six-way comparison, which the mapping UI would then have had to agree
    // with by hand — and a mapping UI that thinks `folder` accumulates while the parser
    // thinks it does not is two different imports of the same file.
    if (target === undefined || (isSingleValuedImportTarget(target) && claimed.has(target))) {
      mapped[key] = 'custom';
      continue;
    }
    if (isSingleValuedImportTarget(target)) claimed.add(target);
    mapped[key] = target;
  }

  return { columns: mapped };
}

/** The header of a CSV, as written, for the mapping UI to label its dropdowns with. */
export function readCsvColumns(content: string): string[] {
  return [...parseCsvTable(content, { maxRows: 1 }).table.columns];
}

// ── The parser ───────────────────────────────────────────────────────────────

function specFor(mapping: ColumnMapping): CsvMappingSpec {
  return {
    targets: mapping.columns,
    ...(mapping.customTypes === undefined ? {} : { customTypes: mapping.customTypes }),
    ...(mapping.customLabels === undefined ? {} : { customLabels: mapping.customLabels }),
  };
}

/**
 * Builds a parser bound to one explicit mapping — what the mapping UI produces.
 *
 * The returned parser's `detect` is `false` on purpose: an explicitly-mapped parser is never
 * auto-suggested, because the mapping it carries belongs to one particular file and offering
 * it for the next one would apply someone's hand-made column choices to a file that has
 * different columns.
 */
export function createGenericCsvParser(mapping: ColumnMapping): ImportParser {
  const spec = specFor(mapping);
  return {
    id: 'generic-csv',
    name: 'Any CSV file',
    extensions: ['.csv'],
    description: 'A CSV with columns you map to Keyhold fields yourself.',
    needsMapping: true,
    detect: () => false,
    parse: (content: string): ImportResult => mapCsv(content, spec),
  };
}

export const genericCsvParser: ImportParser = {
  id: 'generic-csv',
  name: 'Any CSV file',
  extensions: ['.csv'],
  description: 'A CSV with columns you map to Keyhold fields yourself.',
  needsMapping: true,

  /**
   * True for anything that reads as a delimited table.
   *
   * This is the registry's fallback, so it is deliberately generous. The NUL check is the one
   * real filter: a JPEG or a KDBX file handed to a CSV parser would otherwise "detect" as a
   * one-column table full of mojibake.
   */
  detect(content: string): boolean {
    if (content.includes('\0')) return false;
    return readHeaderKeys(content).length >= 2;
  },

  /** Infers the mapping from the file's own header, then runs it. */
  parse(content: string): ImportResult {
    const { table, warnings } = parseCsvTable(content);
    const log = new WarningLog();
    log.addAll(warnings);

    if (table.columns.length === 0) {
      log.add('format', 'The file is empty — there is not even a header row.');
      return { records: [], warnings: log.all, folders: [] };
    }

    const spec: CsvMappingSpec = {
      ...specFor(inferColumnMapping(table.columns)),
      reportInferredCustom: true,
    };
    return mapCsvTable(table, spec, log);
  },
};
