// SPDX-License-Identifier: GPL-3.0-or-later
import type { CustomFieldType } from './credential.js';

/**
 * The vocabulary of the import engine: warnings, column targets, and the placeholder
 * folder identity.
 *
 * This file lives in `@shared` because the **mapping UI** needs every one of these shapes —
 * it renders the warning list, drives the column→field dropdowns, and shows which folders
 * an import would create. It therefore must compile in a browser: types, constants and pure
 * string functions only, and **no Node import, ever**.
 *
 * The parser contract itself (`ImportParser`, `ImportResult`) lives in
 * `src/main/import/types.ts` instead, because it references `NewCredentialInput` — a
 * main-process type — and the renderer has no business constructing credentials.
 */

// ── Warnings ─────────────────────────────────────────────────────────────────

/**
 * Why an import produced a warning.
 *
 * The set is closed and small on purpose: the wizard groups warnings by kind, and an
 * open-ended `string` would make that grouping a guess. Every kind here means "something
 * about your data did not survive intact, and here is exactly what" — an import that
 * silently drops a column is the failure mode this whole vocabulary exists to prevent.
 */
export const IMPORT_WARNING_KINDS = [
  /** A source column had no Keyhold field; it was carried as a custom field. */
  'unmapped-column',
  /** A source value could not be carried at all, and is named here rather than lost quietly. */
  'dropped-value',
  /** A row had more or fewer cells than the header declared. */
  'ragged-row',
  /** A row could not become a record — empty, or missing everything that matters. */
  'skipped-row',
  /** Keyhold filled something in that the source did not have, such as a title from a URL. */
  'derived-value',
  /** An item of a kind this parser does not import as-is (a card, an identity, an SSH key). */
  'unsupported-item',
  /** Something about the file as a whole: a header quirk, a truncated quote, a stale format. */
  'format',
] as const;

export type ImportWarningKind = (typeof IMPORT_WARNING_KINDS)[number];

/**
 * One non-fatal problem.
 *
 * **A warning message never contains a field value.** Warnings are shown on screen, written
 * to the import report, and pasted into bug reports; a message quoting the cell it could not
 * map would put a password in all three. Messages name the *column* and the *line*, never
 * the content — see `src/main/import/warnings.test.ts`, which enforces exactly that.
 */
export interface ImportWarning {
  readonly kind: ImportWarningKind;
  readonly message: string;
  /** 1-based line in the source file, when the problem is row-shaped. */
  readonly line?: number;
  /** The source column header, when the problem is column-shaped. */
  readonly column?: string;
}

/**
 * Builds a warning, omitting the optional keys rather than setting them to `undefined`.
 *
 * `exactOptionalPropertyTypes` is on, so `{ line: undefined }` is not assignable to
 * `{ line?: number }`. This is the one place that has to care.
 */
export function importWarning(
  kind: ImportWarningKind,
  message: string,
  where: { readonly line?: number | undefined; readonly column?: string | undefined } = {}
): ImportWarning {
  return {
    kind,
    message,
    ...(where.line === undefined ? {} : { line: where.line }),
    ...(where.column === undefined ? {} : { column: where.column }),
  };
}

// ── Column mapping ───────────────────────────────────────────────────────────

/**
 * Where a source column ends up.
 *
 * `drop` and `ignore` look alike and are not: `ignore` means "this column is consumed by
 * the parser's own logic, nothing is lost" (Bitwarden's `type` column decides which branch
 * a row takes), while `drop` means "this genuinely does not survive, and the user is told
 * so by name". Collapsing them would turn a reported loss into a silent one.
 */
export const IMPORT_FIELD_TARGETS = [
  'title',
  'username',
  'email',
  'password',
  'url',
  'notes',
  'folder',
  'tags',
  'favorite',
  'totp',
  'custom',
  'drop',
  'ignore',
] as const;

export type ImportFieldTarget = (typeof IMPORT_FIELD_TARGETS)[number];

/**
 * An explicit column→field mapping, as the mapping UI produces it.
 *
 * Keys are **normalised column names** (trimmed, lower-cased) — see `normaliseColumnKey`.
 * Matching on the raw header text would fail on the leading space in `name, url` and on the
 * capitalisation differences between one manager's export and the next.
 */
export interface ColumnMapping {
  readonly columns: Readonly<Record<string, ImportFieldTarget>>;
  /** Overrides the guessed type for a column whose target is `custom`. */
  readonly customTypes?: Readonly<Record<string, CustomFieldType>>;
  /** Overrides the label for a column whose target is `custom`. Defaults to the header text. */
  readonly customLabels?: Readonly<Record<string, string>>;
}

/** The lookup form of a column name. Every mapping key and every table lookup uses this. */
export function normaliseColumnKey(name: string): string {
  return name
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase();
}

// ── Placeholder folder identity ──────────────────────────────────────────────

/**
 * Parsers know folder *names*; only the vault knows folder *ids*.
 *
 * A parser is a pure function over a string — it cannot mint an id, and it must not, because
 * the same import may be previewed three times before it is committed and an id minted
 * during a preview would be a lie. So a parsed record carries a **placeholder** folder id of
 * the form `import-folder:<path>`, and `ImportResult.folders` lists every path involved.
 * The commit stage creates the real folders and rewrites these ids.
 *
 * The prefix is deliberately not a valid UUID, so a placeholder that ever reached the vault
 * would stand out in a dump rather than masquerade as a real folder.
 */
export const IMPORT_FOLDER_ID_PREFIX = 'import-folder:';

export function importFolderId(path: string): string {
  return `${IMPORT_FOLDER_ID_PREFIX}${path}`;
}

export function isImportFolderId(id: string): boolean {
  return id.startsWith(IMPORT_FOLDER_ID_PREFIX);
}

/** The folder path inside a placeholder id, or `null` if this is not one. */
export function importFolderPath(id: string): string | null {
  return isImportFolderId(id) ? id.slice(IMPORT_FOLDER_ID_PREFIX.length) : null;
}

/** Folder paths are `/`-separated regardless of what the source used. */
export const FOLDER_PATH_SEPARATOR = '/';

/**
 * Normalises a source group string to a folder path, or `null` when it names nothing.
 *
 * Accepts both separators unconditionally: LastPass nests with `\`, Bitwarden and 1Password
 * with `/`, and a user who typed the other one by hand should not lose their nesting over it.
 */
export function normaliseFolderPath(raw: string): string | null {
  const segments = raw
    .split(/[\\/]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
  return segments.length === 0 ? null : segments.join(FOLDER_PATH_SEPARATOR);
}

/**
 * Every path that must exist for `path` to exist: `A/B/C` → `A`, `A/B`, `A/B/C`.
 *
 * The caller creates folders, and creating `A/B` without `A` is not possible — so the
 * ancestors are part of the answer, not an exercise left to whoever consumes it.
 */
export function folderAncestors(path: string): string[] {
  const segments = path.split(FOLDER_PATH_SEPARATOR);
  const paths: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    paths.push(segments.slice(0, index + 1).join(FOLDER_PATH_SEPARATOR));
  }
  return paths;
}

// ── Format descriptors ───────────────────────────────────────────────────────

/**
 * What the renderer knows about a format: enough to build a file picker and a format list,
 * and nothing that would require it to hold a parser.
 */
export interface ImportFormatDescriptor {
  readonly id: string;
  readonly name: string;
  readonly extensions: readonly string[];
  /** Shown under the name in the format list. One line, no marketing. */
  readonly description: string;
  /** True for the catch-all that the column-mapping UI drives. */
  readonly needsMapping: boolean;
}
