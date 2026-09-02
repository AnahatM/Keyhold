// SPDX-License-Identifier: GPL-3.0-or-later
import {
  exportLoss,
  PLAINTEXT_EXPORT_WARNING,
  type ExportFormatId,
  type ExportLoss,
  type ExportLossKind,
  type ExportReport,
} from '@shared/model/export.js';

/**
 * The export contract: what an exporter returns, and how a loss is recorded.
 *
 * ## Why the two results are different types
 *
 * A serialiser could have returned bytes and left the warning to the caller. It does not,
 * because "the caller will remember" is exactly the assumption that puts a plaintext dump of
 * someone's whole life on a desktop with no prompt in front of it. The two results are a
 * discriminated union on `containsSecrets`, and the readable one names its payload
 * `secretBytes` — so a caller cannot reach the bytes without narrowing, and cannot narrow
 * without landing on an object whose `warning` is a required, non-nullable string.
 *
 * That is as strong as a type system gets here. It does not stop someone writing the file
 * and never showing the warning; it does stop them doing it *without noticing*.
 *
 * ## Why nothing here writes a file
 *
 * Every function in this module returns bytes. None opens a path, none picks a directory,
 * none touches the temp folder. A plaintext export must land only where the user chose,
 * with the permissions the caller sets, and an exporter that could write a file is an
 * exporter that could write one to `/tmp` by accident. The filesystem is the caller's.
 */

// ── Results ──────────────────────────────────────────────────────────────────

/**
 * A readable export. **These bytes are the vault, in the clear.**
 *
 * `secretBytes` rather than `bytes` deliberately: the naming convention in `CLAUDE.md` says
 * anything holding secret material says so in its name, so a reviewer scanning for where
 * secrets flow finds every site that touches one of these.
 */
export interface PlaintextExport extends ExportReport {
  readonly containsSecrets: true;
  readonly warning: string;
  readonly secretBytes: Uint8Array;
}

/** An export whose payload is sealed. The bytes are safe to hand over; the passphrase is not. */
export interface EncryptedExport extends ExportReport {
  readonly containsSecrets: false;
  readonly warning: null;
  readonly bytes: Uint8Array;
}

export type ExportOutput = PlaintextExport | EncryptedExport;

/** Builds a plaintext result, with the warning attached where it cannot be dropped. */
export function plaintextExport(input: {
  readonly format: ExportFormatId;
  readonly extension: string;
  readonly secretBytes: Uint8Array;
  readonly recordCount: number;
  readonly losses: readonly ExportLoss[];
}): PlaintextExport {
  return {
    format: input.format,
    extension: input.extension,
    containsSecrets: true,
    warning: PLAINTEXT_EXPORT_WARNING,
    recordCount: input.recordCount,
    losses: input.losses,
    secretBytes: input.secretBytes,
  };
}

export function encryptedExport(input: {
  readonly format: ExportFormatId;
  readonly extension: string;
  readonly bytes: Uint8Array;
  readonly recordCount: number;
  readonly losses: readonly ExportLoss[];
}): EncryptedExport {
  return {
    format: input.format,
    extension: input.extension,
    containsSecrets: false,
    warning: null,
    recordCount: input.recordCount,
    losses: input.losses,
    bytes: input.bytes,
  };
}

/**
 * The half of a result that may cross IPC.
 *
 * Built by naming the safe fields rather than by deleting the unsafe one. A `delete
 * result.secretBytes` would keep working when a future field is added and would carry that
 * field straight to the renderer; this cannot, because a new field has to be written in
 * here to appear at all. Same reasoning as the safe projection.
 */
export function reportOf(output: ExportOutput): ExportReport {
  return {
    format: output.format,
    extension: output.extension,
    containsSecrets: output.containsSecrets,
    warning: output.warning,
    recordCount: output.recordCount,
    losses: output.losses,
  };
}

// ── Loss accounting ──────────────────────────────────────────────────────────

/**
 * Accumulates losses, and — the part that matters — collapses per-record complaints into one
 * line each.
 *
 * A 3,000-record vault exported to CSV would otherwise report "history was not carried"
 * 3,000 times, which is indistinguishable from reporting nothing: nobody reads that list, so
 * the loss it describes goes unnoticed. One line saying "history was not carried for 412
 * records" is read. Straight from `WarningLog` on the import side, for the same reason.
 */
export class LossLog {
  readonly #entries: ExportLoss[] = [];
  readonly #counted = new Map<
    string,
    { kind: ExportLossKind; field: string; records: number; describe: (count: number) => string }
  >();

  /** A loss that is not record-scoped: a vault-level setting, a whole structure. */
  add(kind: ExportLossKind, field: string, message: string, records = 0): void {
    this.#entries.push(exportLoss(kind, field, message, records));
  }

  /**
   * Records that one more record lost `field`, without emitting anything yet.
   *
   * `describe` is stored on first sight and called once at flush time with the final count,
   * so the message can state the count without the caller knowing it in advance.
   */
  countRecord(kind: ExportLossKind, field: string, describe: (count: number) => string): void {
    const existing = this.#counted.get(field);
    if (existing === undefined) {
      this.#counted.set(field, { kind, field, records: 1, describe });
      return;
    }
    existing.records += 1;
  }

  /**
   * Emits one entry per counted field, in first-seen order, then clears the counters.
   *
   * First-seen order rather than sorted, because the fields are counted while walking the
   * records in document order — which is itself deterministic — and sorting would only
   * substitute one arbitrary order for another.
   */
  flush(): void {
    for (const counted of this.#counted.values()) {
      this.#entries.push(
        exportLoss(counted.kind, counted.field, counted.describe(counted.records), counted.records)
      );
    }
    this.#counted.clear();
  }

  /** Everything recorded so far. Call `flush` first if anything was counted. */
  get all(): readonly ExportLoss[] {
    return this.#entries;
  }
}
