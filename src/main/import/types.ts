// SPDX-License-Identifier: GPL-3.0-or-later
import type { ImportFormatDescriptor, ImportWarning } from '@shared/model/import.js';
import type { NewCredentialInput } from '../vault/credential-ops.js';

/**
 * The parser contract.
 *
 * A parser is a **pure function from a string to records**. It touches no file, no clock, no
 * key and no id generator. That is what makes the import wizard's dry-run honest: previewing
 * an import runs the identical code that committing it will run, so the preview cannot
 * disagree with the result.
 *
 * It also means a parser never builds a `Credential`. It produces `NewCredentialInput`, and
 * `buildCredential` in `src/main/vault/credential-ops.ts` owns defaults, validation, history
 * settings and identity. An importer that constructed records itself would be a second
 * definition of what a valid record is, and the two would drift.
 */
export interface ImportParser {
  /** Stable, kebab-case, and the key the wizard remembers. Unique across the registry. */
  readonly id: string;
  /** As shown in the format list. */
  readonly name: string;
  /** Lower-case, with the leading dot. Used to filter the file picker and to rank detection. */
  readonly extensions: readonly string[];
  /** One line for the format list. */
  readonly description: string;
  /** True for the catch-all whose mapping the user supplies. */
  readonly needsMapping: boolean;

  /**
   * A cheap check on the first bytes — used to *suggest* a format, never to force one.
   *
   * Must not parse the whole file: it runs once per registered format for every file the
   * user picks. Must not throw on garbage; a binary file handed to it returns `false`.
   */
  detect(content: string): boolean;

  /**
   * Parses the file.
   *
   * Throws only when the file is not this format at all — an encrypted export, or JSON that
   * is not JSON. Everything survivable is a warning, because refusing an entire 3,000-record
   * export over one bad row is how a user ends up retyping their vault by hand.
   */
  parse(content: string): ImportResult;
}

export interface ImportResult {
  readonly records: readonly NewCredentialInput[];
  /**
   * Non-fatal problems: a dropped field, an unparseable row, a column with no home.
   * **Never silently discard.** If something did not survive, it is named here.
   */
  readonly warnings: readonly ImportWarning[];
  /**
   * Every folder path the import needs, ancestors first, so the caller can create them in
   * order. Records point at them through the `import-folder:` placeholder ids.
   */
  readonly folders: readonly string[];
}

/** The renderer-safe half of a parser, for the format list and the file picker. */
export function describeParser(parser: ImportParser): ImportFormatDescriptor {
  return {
    id: parser.id,
    name: parser.name,
    extensions: parser.extensions,
    description: parser.description,
    needsMapping: parser.needsMapping,
  };
}

export const EMPTY_IMPORT_RESULT: ImportResult = { records: [], warnings: [], folders: [] };
