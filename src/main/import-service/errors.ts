// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The refusals the import service raises.
 *
 * Deliberately **not** `VaultError`, for the same reason `organisation/errors.ts` is not:
 * every code in that enum means "this file is damaged, hostile, or from the future", and
 * saying that because a preview went stale would be a lie told on the one screen where the
 * user is already nervous about their whole vault.
 *
 * Two of these codes are load-bearing rather than decorative. The wizard reacts to
 * `import/stale-plan` and `import/stale-undo` **by name** — see `IMPORT_ERROR_CODES` in
 * `IMPORT_ERROR_CODES` — because those two failures have a specific answer ("run the preview
 * again", "the vault moved on") that a generic message cannot give. The codes therefore live
 * in `@shared/model/import-plan.js`, beside the channels that carry them, and are re-exported
 * here under the name this module already used. They were briefly declared twice, once on
 * each side of the boundary, with a test comparing one file's *text* against the other's —
 * which is a guard doing what a shared constant does for free.
 *
 * The rule from `crypto/errors.ts` holds here with particular force: **a message never
 * contains a value out of the file being imported.** The file is a plaintext dump of
 * somebody's entire password vault, and these messages are shown on screen, written into
 * the import report and pasted into bug reports. They name the *thing that went wrong*, and
 * at most a position in the file — never a cell, never a column's contents, never a title.
 */

import { IMPORT_ERROR_CODES, type ImportErrorCode } from '@shared/model/import-plan.js';

export { IMPORT_ERROR_CODES, type ImportErrorCode };

export class ImportServiceError extends Error {
  readonly code: ImportErrorCode;
  /** True when retrying with different input, or after re-previewing, could work. */
  readonly recoverable: boolean;

  constructor(code: ImportErrorCode, message: string, recoverable: boolean) {
    super(message);
    this.name = 'ImportServiceError';
    this.code = code;
    this.recoverable = recoverable;
  }
}

/**
 * The file behind a source id, or a plan behind a plan id, is gone.
 *
 * Recoverable: the wizard's answer is to run the preview again, which is a click, not a
 * dead end.
 */
export function stalePlan(
  message = 'This preview is out of date. Run it again before importing.'
): ImportServiceError {
  return new ImportServiceError(IMPORT_ERROR_CODES.stalePlan, message, true);
}

/** The vault changed after the commit. Not recoverable — the offer is withdrawn, not retried. */
export function staleUndo(): ImportServiceError {
  return new ImportServiceError(
    IMPORT_ERROR_CODES.staleUndo,
    'The vault changed after this import, so it can no longer be taken back automatically.',
    false
  );
}

export function unknownFormat(): ImportServiceError {
  return new ImportServiceError(
    IMPORT_ERROR_CODES.unknownFormat,
    'Keyhold does not have a reader for that format.',
    true
  );
}

export function mappingRequired(): ImportServiceError {
  return new ImportServiceError(
    IMPORT_ERROR_CODES.mappingRequired,
    'This format needs you to say which column holds which field.',
    true
  );
}

export function fileTooLarge(limitBytes: number): ImportServiceError {
  return new ImportServiceError(
    IMPORT_ERROR_CODES.fileTooLarge,
    `That file is larger than the ${Math.round(limitBytes / (1024 * 1024))} MB import limit.`,
    true
  );
}

/**
 * The parser threw.
 *
 * The underlying message is **not** carried through. A parser that fails deep inside
 * `JSON.parse` produces messages like `Unexpected token p in JSON at position 41`, and the
 * bytes around position 41 are somebody's password. The user is told which file and which
 * format, both of which they chose, and nothing that came out of the file.
 */
export function unreadableFile(formatName: string): ImportServiceError {
  return new ImportServiceError(
    IMPORT_ERROR_CODES.unreadableFile,
    `That file could not be read as ${formatName}. It may be encrypted, or a different format.`,
    true
  );
}
