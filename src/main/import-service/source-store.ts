// SPDX-License-Identifier: GPL-3.0-or-later
import type { ImportSource, ImportSourceId } from '@shared/model/import-plan.js';
import type { ColumnMapping } from '@shared/model/import.js';
import { SecretBytes } from '../crypto/secret.js';
import {
  detectFormat,
  detectFormats,
  extensionOf,
  inferColumnMapping,
  readCsvColumns,
  stripBom,
} from '../import/index.js';
import { fileTooLarge } from './errors.js';

/**
 * The held file.
 *
 * ## What this module is actually protecting
 *
 * A credential export is a plaintext dump of every password its owner has. While the wizard
 * is open, this process is holding one. That is unavoidable — nothing can be imported
 * without being read — so the design job is to hold **as little of it, for as short a time,
 * in as few shapes as possible**, and to be able to say precisely what "discard" destroyed.
 *
 * Three decisions follow from that:
 *
 * **The bytes live in a `SecretBytes`, not a `Buffer`.** `SecretBytes` overrides
 * `toString`, `toJSON` and `util.inspect`, so a stray log line, a `JSON.stringify` of a
 * state object, or an error thrown with the source attached prints `[SecretBytes: redacted]`
 * rather than a thousand passwords. `destroy()` then zeroes the page rather than merely
 * dropping the reference — see `crypto/secret.ts` for what that is and is not worth.
 *
 * **The decoded text is never retained.** A JavaScript string is immutable and cannot be
 * zeroed, so a held `string` copy of the file would be a second plaintext dump that
 * `discard` is structurally unable to destroy. {@link HeldSource.readSecretText} therefore
 * decodes on demand from the bytes and hands the result to its caller, which is expected to
 * drop it as soon as the parse is done. One transient copy per parse, collectable
 * immediately, instead of one permanent copy for the lifetime of the wizard.
 *
 * **Only non-secret facts survive into {@link ImportSource}.** The basename, the size, the
 * candidate formats and the header row — nothing else crosses, and the path in particular
 * does not: the wizard has no use for the directory, and a full path is the kind of thing
 * that ends up in a screenshot attached to a bug report.
 */

/**
 * The size ceiling for an import.
 *
 * Sixty-four megabytes is roughly two hundred thousand records of CSV — an order of
 * magnitude past the largest real export anyone has — so the limit never fires on a genuine
 * file. It exists because the alternative to a limit is holding an arbitrarily large
 * plaintext buffer in a process that also holds the master key, on the strength of a file
 * dialog.
 */
export const MAX_IMPORT_FILE_BYTES = 64 * 1024 * 1024;

/** What the picker hands over: a basename and bytes, and deliberately not a path. */
export interface PickedImportFile {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export interface HeldSource {
  readonly descriptor: ImportSource;
  /**
   * The file's text, decoded fresh.
   *
   * Named for what it is. Every caller of this holds a plaintext credential dump for the
   * duration of one expression and must not park it in a field.
   */
  readSecretText: () => string;
  /** Zeroes the bytes. Idempotent, so a double discard is safe. */
  destroy: () => void;
}

/**
 * Reads the file's text.
 *
 * BOM-aware in both directions, because it has to be: KeePass and several LastPass builds
 * write UTF-16LE with a BOM, and decoding those as UTF-8 produces a "file" whose every
 * other byte is a NUL — which every parser in the registry correctly refuses, leaving the
 * user with "this is not a CSV" for a CSV. UTF-16BE is byte-swapped by hand rather than
 * decoded directly, because `TextDecoder('utf-16be')` is only present in a full-ICU build
 * and this must work on every one.
 */
export function decodeSourceText(bytes: Uint8Array): string {
  const [first, second] = [bytes[0], bytes[1]];

  if (first === 0xff && second === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (first === 0xfe && second === 0xff) {
    const swapped = new Uint8Array(bytes.length - 2);
    for (let index = 0; index + 1 < swapped.length; index += 2) {
      swapped[index] = bytes[index + 3] ?? 0;
      swapped[index + 1] = bytes[index + 2] ?? 0;
    }
    return new TextDecoder('utf-16le').decode(swapped);
  }

  return stripBom(new TextDecoder('utf-8').decode(bytes));
}

/**
 * Takes ownership of a picked file and builds the renderer's view of it.
 *
 * Detection runs here rather than at preview time so the wizard can pre-select a format on
 * the very first screen. It is a *suggestion* — `detectFormat` says so at length — and the
 * candidate list beside it is what lets the user say "no, it's the other one".
 */
export function holdSource(sourceId: ImportSourceId, file: PickedImportFile): HeldSource {
  if (file.bytes.length > MAX_IMPORT_FILE_BYTES) {
    // Zero what we were handed before refusing. The caller transferred ownership, and a
    // refusal that leaves the bytes alive is a leak with a polite error message on top.
    file.bytes.fill(0);
    throw fileTooLarge(MAX_IMPORT_FILE_BYTES);
  }

  const contentSecret = SecretBytes.adopt(file.bytes);
  const secretText = contentSecret.use(decodeSourceText);

  const detected = detectFormat(file.fileName, secretText);
  const candidates = detectFormats(file.fileName, secretText);
  const { columns, inferredMapping } = readColumnar(secretText);

  const descriptor: ImportSource = {
    sourceId,
    fileName: file.fileName,
    extension: extensionOf(file.fileName),
    sizeBytes: contentSecret.length,
    detectedFormatId: detected?.id ?? null,
    candidateFormatIds: candidates.map((parser) => parser.id),
    columns,
    inferredMapping,
  };

  return {
    descriptor,
    readSecretText: () => contentSecret.use(decodeSourceText),
    destroy: () => {
      contentSecret.destroy();
    },
  };
}

/**
 * The header row and the mapping guessed from it, or nothing for a file that has no columns.
 *
 * The JSON check is on the content's first non-space character rather than on the detected
 * format, because the format is a suggestion the user can override and this is a fact about
 * the file. Handing a JSON document to the CSV column reader would otherwise produce a
 * "header row" made of braces, and a mapping UI offering to map a column called `{`.
 */
function readColumnar(secretText: string): {
  columns: readonly string[];
  inferredMapping: ColumnMapping | null;
} {
  const head = secretText.trimStart().charAt(0);
  if (head === '{' || head === '[') return { columns: [], inferredMapping: null };

  try {
    const columns = readCsvColumns(secretText);
    if (columns.length === 0) return { columns: [], inferredMapping: null };
    return { columns, inferredMapping: inferColumnMapping(columns) };
  } catch {
    // Not a table. That is not an error here — the user may still have picked a format that
    // reads the file some other way — so the mapping UI simply has nothing to offer.
    return { columns: [], inferredMapping: null };
  }
}
