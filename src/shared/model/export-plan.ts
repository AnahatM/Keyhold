// SPDX-License-Identifier: GPL-3.0-or-later

import type { ExportFormatId, ExportLoss, ExportReport } from './export.js';

/**
 * The export *request* contract: what the renderer may ask for, and what comes back.
 *
 * `export.ts` is the vocabulary of a finished export — formats, losses, the mandatory
 * warning, the report. This file is the vocabulary of one the user is still deciding on: a
 * scope, a chosen format, the thing they had to type before a plaintext file could be
 * written, and the passphrase a parcel is sealed under.
 *
 * It lives in `@shared` because both sides need it and neither may own it alone. The
 * renderer builds a plan; the main process validates it *again* and executes it. Types,
 * constants and pure string functions only — **no Node import, ever**.
 *
 * ## Three things this file is deliberately shaped to make impossible
 *
 * **A plaintext export with no confirmation.** `PlaintextExportPlan.confirmation` is a
 * required string, and {@link matchesPlaintextConfirmation} is the *only* implementation of
 * what counts as a match. The renderer refuses to build a plan without it; the main process
 * refuses to execute one whose confirmation does not match. Two independent checks against
 * one function — the renderer's check is a UX affordance, the main process's is the actual
 * gate, because a compromised renderer can send whatever it likes.
 *
 * **A silent trash decision.** `ExportScope.includeTrashed` is a required boolean, not an
 * optional one. `ExportSelection` in the engine makes it optional so that a caller who
 * forgets it gets the safe behaviour; here, at the boundary where a *person* is choosing,
 * forgetting is not an option that should compile. The dialog shows the count either way.
 *
 * **A renderer-chosen path.** There is no path anywhere in a plan. The main process opens
 * the save dialog, the user picks the destination, and the renderer learns where the file
 * landed only *afterwards*, from {@link ExportLocation}. A path travelling renderer → main
 * would be attacker-controlled if the renderer were ever compromised; a path travelling
 * main → renderer after the user picked it in an OS dialog is a fact, not an instruction.
 *
 * ## And one thing it is shaped to keep out
 *
 * **Bytes.** Nothing here carries a payload, in either direction. An {@link ExportOutcome}
 * describes a file; it never contains one. See the header of `src/main/export/types.ts` for
 * why the byte-carrying types stay beside the code that produces them.
 */

// ── Scope ────────────────────────────────────────────────────────────────────

/**
 * Which records an export covers, as chosen by a person rather than by a caller.
 *
 * Maps onto the engine's `ExportSelection` one field at a time, with `recordIds: null`
 * meaning "the whole vault" where the engine uses `undefined`. Stated as `null` because
 * this crosses IPC and `undefined` does not survive structured clone as a *present* key —
 * a distinction that matters when the difference between absent and empty is the
 * difference between exporting everything and exporting nothing.
 */
export interface ExportScope {
  /**
   * Include records the user has trashed.
   *
   * Required, and there is no default. Off is the answer the dialog starts with, but the
   * plan records a decision rather than an omission.
   */
  readonly includeTrashed: boolean;
  /**
   * The chosen subset, or `null` for every record.
   *
   * An empty array is a legitimate — if odd — request for an empty export, and is not the
   * same as `null`. The engine draws the same distinction.
   */
  readonly recordIds: readonly string[] | null;
}

/** The starting point the dialog opens on: everything, minus the Trash. */
export const WHOLE_VAULT_SCOPE: ExportScope = { includeTrashed: false, recordIds: null };

// ── The confirmation ─────────────────────────────────────────────────────────

/**
 * What a user must type before a readable copy of their vault is written to disk.
 *
 * A button cannot express this. Clicking "Export" is the same gesture as clicking "Cancel"
 * — a reflex aimed at whichever control is under the pointer — and this is the one
 * operation in Keyhold that turns an encrypted vault into a file anybody can open. Typing a
 * phrase is the cheapest way to require that someone has actually read the sentence above
 * it.
 *
 * The phrase names the consequence rather than the action. "EXPORT" would be typed
 * automatically by anyone who has met a confirm box before; "EXPORT UNENCRYPTED" cannot be
 * typed without reading the word that matters.
 */
export const PLAINTEXT_CONFIRMATION_PHRASE = 'EXPORT UNENCRYPTED';

/**
 * The comparable form of what someone typed: trimmed, inner runs of whitespace collapsed,
 * upper-cased.
 *
 * Deliberately forgiving, and the leniency is the point. The confirmation exists to prove
 * *deliberateness*, not typing accuracy — rejecting `export unencrypted` or a stray double
 * space would add no security whatsoever and would turn a safety measure into an obstacle
 * people learn to resent. Nothing else is accepted: a missing word, a different word or a
 * substring all fail.
 */
export function normaliseConfirmation(typed: string): string {
  return typed.trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Whether a typed confirmation authorises a plaintext export.
 *
 * **The single definition.** The dialog calls it to enable a button; the main process calls
 * it to decide whether to write a file. A second implementation on either side is how the
 * two come to disagree, and the side that would be wrong is the one holding the vault.
 */
export function matchesPlaintextConfirmation(typed: string): boolean {
  return normaliseConfirmation(typed) === PLAINTEXT_CONFIRMATION_PHRASE;
}

// ── Plans ────────────────────────────────────────────────────────────────────

/**
 * An export of a format whose bytes anyone can read.
 *
 * `kind` is redundant with `format` — the format registry already knows which formats are
 * encrypted — and is here anyway so that the main process can cross-check the two. A plan
 * claiming `kind: 'plaintext'` for a format the registry calls encrypted, or the reverse,
 * is either a bug or a renderer trying to skip the confirmation, and both deserve a
 * refusal rather than a best guess.
 */
export interface PlaintextExportPlan {
  readonly kind: 'plaintext';
  readonly format: ExportFormatId;
  readonly scope: ExportScope;
  /**
   * Exactly what the user typed, unnormalised.
   *
   * Sent raw so that the main process runs {@link matchesPlaintextConfirmation} itself
   * rather than trusting a boolean the renderer computed. A boolean would make the gate
   * exactly as strong as the renderer, which is the assumption decision D13 exists to
   * refuse to make.
   */
  readonly confirmation: string;
}

/**
 * An export sealed in a KEEP container under its own passphrase.
 *
 * Named `secretPassphrase` per the naming rule, because it is secret material: it travels
 * renderer → main, which is the direction secrets are allowed to travel (the user typed
 * it), and it must never travel back, be logged, or appear in an error.
 */
export interface ParcelExportPlan {
  readonly kind: 'encrypted';
  readonly format: 'keyhold-parcel';
  readonly scope: ExportScope;
  readonly secretPassphrase: string;
}

export type ExportPlan = PlaintextExportPlan | ParcelExportPlan;

// ── Preview ──────────────────────────────────────────────────────────────────

/**
 * What the dialog asks about before anything is written.
 *
 * Carries no confirmation and no passphrase: a preview happens *before* the user has been
 * asked for either, and a request shape that could carry a passphrase is one that
 * eventually does.
 */
export interface ExportPreviewRequest {
  readonly format: ExportFormatId;
  readonly scope: ExportScope;
}

/**
 * What this export would cost, computed without writing anything.
 *
 * The whole reason the dialog has a preview step: "it is impossible to export a CSV and be
 * surprised that history is gone" is only true if the loss list is on screen *before* the
 * button is pressed. `losses` is the engine's own itemised list, not a summary of it, so
 * the dialog never has to describe a format in its own words.
 */
export interface ExportPreview {
  readonly format: ExportFormatId;
  /** Records that would actually be written, under this scope and this trash setting. */
  readonly recordCount: number;
  /**
   * Trashed records the scope covers, **whether or not they would be written**.
   *
   * Reported independently of `includeTrashed` so the dialog can show the number either
   * way. "12 records in the Trash are being left out" and "12 records in the Trash will be
   * included" are the same fact, and the user is owed it in both directions.
   */
  readonly trashedInScope: number;
  /** Selected ids that are no longer in this vault. A stale selection, not an error. */
  readonly unknownIds: number;
  /** True when the bytes would be readable. Drives the type-to-confirm step. */
  readonly containsSecrets: boolean;
  readonly losses: readonly ExportLoss[];
}

// ── Outcome ──────────────────────────────────────────────────────────────────

/**
 * Where the file went.
 *
 * Split into a directory and a name rather than handed over as one path string, because
 * the renderer's only legitimate use for this is telling the user where to look. Composing
 * a path is a thing the renderer must never need to do, and a shape that is inconvenient to
 * concatenate is a small nudge away from doing it anyway.
 */
export interface ExportLocation {
  readonly fileName: string;
  readonly directory: string;
  readonly byteLength: number;
}

/**
 * How an export ended.
 *
 * `cancelled` is a first-class outcome, not a failure: the user dismissing the OS save
 * dialog is the system working. Reporting it as an error would train people to ignore
 * export errors.
 */
export type ExportOutcome =
  | {
      readonly status: 'written';
      readonly report: ExportReport;
      readonly location: ExportLocation;
    }
  | { readonly status: 'cancelled' }
  | {
      readonly status: 'failed';
      readonly code: string;
      /** Already scrubbed by the main process. Never contains a value or a full path. */
      readonly message: string;
    };

// ── The aftermath ────────────────────────────────────────────────────────────

/**
 * What is still true about a plaintext export after it has been written.
 *
 * `PLAINTEXT_EXPORT_WARNING` is what the file *is*; this is what the file *remains*, and it
 * is a separate sentence because it is needed at a separate moment — the warning is read
 * before the decision, this is read after it, and by then "save it somewhere only you can
 * reach" is advice about a thing that has already happened.
 *
 * It states plainly that Keyhold does not shred the file. It would be easy and comforting
 * to offer a "securely delete" button; on a modern SSD with wear levelling and a
 * copy-on-write filesystem, overwriting a file's blocks does not reliably overwrite the
 * data, and shipping a button that says "securely" while the data survives is worse than
 * shipping nothing. So it says what is true and stops.
 */
export const PLAINTEXT_AFTERMATH_REMINDER =
  'Deleting this file will not erase it. Sending it to the Recycle Bin or Trash removes the name, ' +
  'not the contents — those stay on the drive until something else happens to overwrite them, and ' +
  'Keyhold does not shred files. Copies may already exist in a backup, a sync folder, or your ' +
  'operating system’s search index. Treat it as readable until the whole drive is encrypted or ' +
  'replaced.';

// ── Channels ─────────────────────────────────────────────────────────────────

/**
 * The export IPC surface.
 *
 * Three calls and no fourth. There is deliberately no "give me the bytes" channel: the file
 * is written by the main process, to a path the user chose in an OS dialog, and the renderer
 * learns only where it landed. A channel that returned the bytes would put a plaintext copy
 * of the whole vault in the renderer for as long as the garbage collector felt like keeping
 * it -- which is decision D13's exact prohibition, arrived at from the other direction.
 *
 * Spread into `CHANNELS` in `@shared/ipc/api.ts` rather than restated there, so the names
 * exist once. `ExporterApi` in that file is the typed half of the same contract.
 */
export const EXPORT_CHANNELS = {
  exportFormats: 'kh:export:formats',
  exportPreview: 'kh:export:preview',
  exportRun: 'kh:export:run',
} as const;
