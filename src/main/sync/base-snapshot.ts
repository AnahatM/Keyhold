// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VaultDocument } from '@shared/model/vault-document.js';

/**
 * The last state both devices agreed on, kept so the next merge is three-way.
 *
 * ## Why a merge without this is worse than it looks
 *
 * `mergeDocuments(base, ours, theirs)` takes `base | null`, and it works either way — but
 * the two behave very differently. With no ancestor, every field that differs is a conflict,
 * because there is no way to tell "I changed this" from "they changed this". With one, the
 * engine can see that only one side moved and take it silently. The difference between a
 * merge that asks about four fields and one that asks about four hundred is entirely this
 * file.
 *
 * The sharper case is deletion. Without an ancestor, a record present on one side and absent
 * on the other is indistinguishable from a record that was created on one side — so the safe
 * answer is to keep it, and a deletion synced from another device silently comes back. With
 * an ancestor, "was there, is gone" and "was never there" are different facts.
 *
 * ## Why it is stored, and where
 *
 * **Beside the vault would be wrong.** A `.keep` in a cloud folder is copied, moved, and
 * synced by something that knows nothing about us; a snapshot next to it would be synced
 * too, and a snapshot that arrives from *another* device is not this device's last-agreed
 * state — it is a lie about what this device has seen, which is the one input a three-way
 * merge cannot survive being wrong about.
 *
 * So it lives in this machine's own application data, keyed by vault id, and never travels.
 * That is the same argument the network kill-switch makes for being machine-scoped, and the
 * reason `deviceId` exists in the header at all.
 *
 * ## Why it is stored in the clear, and why that is not a hole
 *
 * It is not. A snapshot is a whole vault document — every password in it — so it is written
 * with the same key the vault is, through the caller. This module deliberately does **not**
 * encrypt: it takes bytes and returns bytes, and the sealing is the caller's, so there is
 * exactly one place in the app that knows how to turn a document into ciphertext. Composing
 * `src/main/crypto/` beats a second sealing path that has to be reviewed separately.
 *
 * The `store` API therefore speaks in already-sealed bytes. A caller that hands it plaintext
 * is making a mistake this module cannot detect, which is why the parameter is named for
 * what it must be.
 */

/** Where snapshots live, under the app's own data directory. */
const DIRECTORY_NAME = 'base-snapshots';

export interface BaseSnapshotStore {
  /** The sealed snapshot for a vault, or `null` when there has never been a merge. */
  read: (vaultId: string) => Uint8Array | null;
  /** Replaces the snapshot. Called after a merge, with the merged document sealed. */
  write: (vaultId: string, sealedBytes: Uint8Array) => void;
  /** Drops it — for "forget this vault", and for a snapshot that will not open. */
  forget: (vaultId: string) => void;
}

/**
 * A file per vault, named by a digest of the vault id rather than the id itself.
 *
 * The id is a UUID and not a secret, but the directory is browsable by anything running as
 * this user, and a folder listing that enumerates *which vaults this person has* is a fact
 * worth not publishing for free. A digest gives a stable, filesystem-safe name that leaks
 * nothing on its own.
 *
 * Not for confidentiality against someone holding the id — they can compute the same digest.
 * It is a listing that stops being informative, which is the honest description.
 */
function fileNameFor(vaultId: string): string {
  return `${createHash('sha256').update(vaultId, 'utf8').digest('hex').slice(0, 32)}.keepbase`;
}

export function createBaseSnapshotStore(dataDirectory: string): BaseSnapshotStore {
  const directory = join(dataDirectory, DIRECTORY_NAME);

  return {
    read: (vaultId) => {
      try {
        return new Uint8Array(readFileSync(join(directory, fileNameFor(vaultId))));
      } catch {
        // Absent, unreadable, or damaged — all one answer. A missing ancestor degrades a
        // merge to two-way, which is worse but correct; throwing here would turn "we have
        // never merged" into an error on a path where it is the normal case.
        return null;
      }
    },

    write: (vaultId, sealedBytes) => {
      mkdirSync(directory, { recursive: true });
      // Not `writeVaultFileAtomically`: that owns the rolling `.keepbak` rotation and the
      // fsync-the-directory dance a *vault* needs, and a snapshot is neither. Losing one
      // costs the next merge some extra questions; it never costs a record. Writing it
      // through the vault's path would earn none of that and would put a second kind of file
      // through the code most carefully shaped around exactly one.
      writeFileSync(join(directory, fileNameFor(vaultId)), sealedBytes);
    },

    forget: (vaultId) => {
      rmSync(join(directory, fileNameFor(vaultId)), { force: true });
    },
  };
}

/**
 * Whether a document is worth storing as the new ancestor.
 *
 * Exists because the answer is not "always". A snapshot taken from a document that failed to
 * write is an ancestor describing a state no file ever held, and the *next* merge would then
 * treat the user's real edits as changes away from something that never existed — silently
 * resolving in favour of the other device.
 *
 * So the caller stores the snapshot **after** the merged vault is safely on disk, and this
 * is the reminder in code rather than a comment on the call site.
 */
export function snapshotIsSafeToStore(options: {
  readonly mergedWasWritten: boolean;
  readonly unresolvedConflicts: number;
}): boolean {
  // An unresolved conflict means the merge is not finished. Recording it as the agreed
  // ancestor would mean the next merge believes both sides already settled a question
  // nobody answered.
  return options.mergedWasWritten && options.unresolvedConflicts === 0;
}

/** The bytes of a document, for a caller about to seal them. Deterministic by construction. */
export function serialiseSnapshot(document: VaultDocument): Uint8Array {
  // `JSON.stringify` on the document, exactly as the vault body is written — the snapshot is
  // read back by the same parser, so a second serialisation format here would be a second
  // thing to keep in step with the first.
  return new Uint8Array(Buffer.from(JSON.stringify(document), 'utf8'));
}

/**
 * Whether two vault files need reconciling at all.
 *
 * The question a watcher has to answer before it prompts anybody, and the reason
 * `KeepHeader.contentHash` exists. Both headers are **plaintext**, so this is answerable
 * without a key, without unlocking, and without decrypting a byte — which is what makes it
 * cheap enough to run on every filesystem event.
 *
 * Three answers, and the middle one is the one that matters:
 *
 *  - **`identical`** — same content hash. A file copied, re-synced, or written twice with no
 *    edit in between. No merge, no prompt, no backup. Without this, every cloud client that
 *    touches a file would produce a resolver dialog for a vault nobody changed, which is how
 *    people learn to dismiss the dialog that matters.
 *  - **`differs`** — different hashes. Genuinely divergent; the merge path is warranted.
 *  - **`unknown`** — either side has no hash, because it was written before the field
 *    existed. Falls back to comparing generations, which is what the app had before and is
 *    correct-but-noisy: it can say "differs" for two identical files. Never the other way
 *    round, which is the direction that matters — a false "identical" would skip a merge and
 *    lose an edit.
 */
export type VaultComparison = 'identical' | 'differs' | 'unknown';

export function compareVaultContent(
  ours: { readonly contentHash?: string | undefined; readonly generation: number },
  theirs: { readonly contentHash?: string | undefined; readonly generation: number }
): VaultComparison {
  if (ours.contentHash !== undefined && theirs.contentHash !== undefined) {
    return ours.contentHash === theirs.contentHash ? 'identical' : 'differs';
  }
  // No hash on one side. `generation` is a counter, not a fingerprint: two devices editing
  // from the same ancestor both reach 8 and disagree completely, so equal generations are
  // not evidence of equal content. Reported as unknown rather than guessed, so the caller
  // decides whether to pay for a full comparison rather than being told something false.
  return 'unknown';
}
