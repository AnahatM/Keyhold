// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The vocabulary of the export engine: format identities, what each format loses, and the
 * sentence the UI is obliged to show before a plaintext export leaves the app.
 *
 * This file lives in `@shared` because the **export dialog** needs every one of these
 * shapes — it renders the format list, the loss list, and the warning. It therefore must
 * compile in a browser: types, constants and pure string functions only, and **no Node
 * import, ever**.
 *
 * What is deliberately *not* here: the bytes. `ExportReport` is the renderer-safe half of an
 * export — what format it is, how many records it covers, what did not survive — and it
 * carries no payload. The byte-carrying result types live in `src/main/export/types.ts`,
 * beside the code that produces them, for the same reason the vault document does: a
 * plaintext export is the single most dangerous artefact this application can produce, and
 * decision D13 says the renderer never holds secret material. An export dialog needs to
 * describe a file, not to hold one.
 */

// ── Formats ──────────────────────────────────────────────────────────────────

/**
 * Every format the engine can produce.
 *
 * Closed and small on purpose. The dialog groups by id, the loss list is keyed by id, and an
 * open-ended `string` would make both a guess.
 */
export const EXPORT_FORMAT_IDS = [
  /** Complete and lossless: every field, every version, every origin. Plaintext. */
  'keyhold-json',
  /** A flat spreadsheet of the vault. Plaintext, and lossy — see `ExportLoss`. */
  'keyhold-csv',
  /** The leaving-Keyhold path: columns other managers accept. Plaintext, and lossy. */
  'compatible-csv',
  /** The Keyhold JSON sealed in a KEEP container under its own passphrase. */
  'keyhold-parcel',
] as const;

export type ExportFormatId = (typeof EXPORT_FORMAT_IDS)[number];

/**
 * What the renderer knows about a format: enough to build a format list and a save dialog,
 * and nothing that would require it to hold an exporter.
 */
export interface ExportFormatDescriptor {
  readonly id: ExportFormatId;
  readonly name: string;
  /** Lower-case, with the leading dot. Drives the save dialog's filter and default name. */
  readonly extension: string;
  /** One line for the format list. No marketing. */
  readonly description: string;
  /** False means the bytes are readable by anyone who opens the file. */
  readonly encrypted: boolean;
  /** True only for a format that can be read back into an identical vault. */
  readonly lossless: boolean;
}

// ── Losses ───────────────────────────────────────────────────────────────────

/**
 * Why something about the vault did not arrive in the file intact.
 *
 * The mirror of `ImportWarningKind`, and it exists for the same reason: an export that
 * silently drops a column is the failure mode this vocabulary is here to prevent. A user who
 * exports to CSV, deletes their vault, and *then* discovers their security answers are gone
 * has been failed by an exporter that said nothing.
 *
 * `dropped` and `flattened` look alike and are not. `flattened` means "the data is in the
 * file, but not as its own structure" — a custom field packed into a shared cell survives a
 * round trip as a custom field. `dropped` means "this is not in the file at all". Collapsing
 * them would turn a reported loss of *shape* into an unreported loss of *data*.
 */
export const EXPORT_LOSS_KINDS = [
  /** Not representable in this format at all. The data is not in the file. */
  'dropped',
  /** Carried, but not as its own structure — packed into a shared cell, or joined. */
  'flattened',
  /** Left out because the caller asked for it to be, such as trashed records. */
  'excluded',
  /** The value in the file is not byte-identical to the value in the vault. */
  'altered',
] as const;

export type ExportLossKind = (typeof EXPORT_LOSS_KINDS)[number];

/**
 * One thing this format could not carry intact.
 *
 * **A loss message never contains a field value.** Losses are shown on screen, written into
 * export reports, and pasted into bug reports; a message quoting the value it could not
 * carry would put a password in all three. Messages name the *field* and a *count*, never
 * the content — `csv.test.ts` enforces exactly that with a marker-planting property test,
 * the same way the import warnings and the health report are enforced.
 */
export interface ExportLoss {
  readonly kind: ExportLossKind;
  /** The Keyhold field or structure involved: `history`, `attachments`, `custom field type`. */
  readonly field: string;
  /** Plain English, addressed to the user, naming no value. */
  readonly message: string;
  /** How many records were affected. `0` when the loss is not record-scoped. */
  readonly records: number;
}

export function exportLoss(
  kind: ExportLossKind,
  field: string,
  message: string,
  records = 0
): ExportLoss {
  return { kind, field, message, records };
}

// ── The warning ──────────────────────────────────────────────────────────────

/**
 * The sentence that must appear before any plaintext export is written.
 *
 * It is a constant rather than UI copy so that it cannot be forgotten by a second caller,
 * and it is returned *in the result* rather than merely exported from here so that a caller
 * cannot obtain the bytes without also holding the warning — see `PlaintextExport` in
 * `src/main/export/types.ts`.
 *
 * It names the file's real reach rather than saying "be careful": the sync folder and the
 * mail attachment are where these files actually end up, and a warning that does not say so
 * is one people click past.
 */
export const PLAINTEXT_EXPORT_WARNING =
  'This file contains every password, note and security answer in readable text. Anyone who ' +
  'opens it can read them — and so can anything it passes through, including cloud sync ' +
  'folders, backups, mail attachments and your operating system’s search index. Save it ' +
  'somewhere only you can reach, use it straight away, then delete it.';

// ── The renderer-safe half of a result ───────────────────────────────────────

/**
 * Everything about a finished export except the bytes.
 *
 * This is what crosses IPC. `containsSecrets` is a plain boolean here rather than a literal
 * because the renderer only ever reads it; the main-process types narrow it to `true` or
 * `false` per branch so that *producing* a plaintext export without a warning is a type
 * error rather than an oversight.
 */
export interface ExportReport {
  readonly format: ExportFormatId;
  readonly extension: string;
  /** True when the bytes are readable. The UI must show `warning` before writing them. */
  readonly containsSecrets: boolean;
  /** Non-null exactly when `containsSecrets` is true. */
  readonly warning: string | null;
  /** Records actually written, after trashed exclusion and any id selection. */
  readonly recordCount: number;
  readonly losses: readonly ExportLoss[];
}

/**
 * A default file name, without a path. The caller owns the directory and the save dialog.
 *
 * Letters, digits, spaces, `_` and `-` survive; everything else is removed. Dots go too,
 * which costs a vault called `notes.v2` its dot and buys the guarantee that no name produced
 * here can contain `..` — a vault name is user-supplied text and this string is handed to a
 * file API.
 */
export function exportFileName(vaultName: string, descriptor: ExportFormatDescriptor): string {
  const safe = vaultName.replace(/[^\p{L}\p{N} _-]/gu, '').trim();
  return `${safe === '' ? 'vault' : safe}-export${descriptor.extension}`;
}
