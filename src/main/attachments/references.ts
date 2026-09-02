// SPDX-License-Identifier: GPL-3.0-or-later
import type { AttachmentMeta, Credential } from '@shared/model/credential.js';
import type { VaultDocument } from '@shared/model/vault-document.js';

/**
 * Who points at which chunk, and therefore what may be deleted.
 *
 * ## The rule this file exists to enforce
 *
 * **A chunk may be deleted only when no metadata anywhere still points at it.** Dedupe
 * means one chunk can be the payload of several attachments on several records, so the
 * naive "the record owned it, drop it" is a data-loss bug: deleting a record deletes a file
 * another record is still showing. Every deletion path goes through a reference count
 * computed here, and nowhere re-derives it.
 *
 * ## Trashed records still count
 *
 * Deliberately, and it is the least obvious decision in this file. A trashed record is
 * restorable — that is the entire point of trash — so dropping its chunks would hand the
 * user back a record whose attachments are gone. Only `purgeCredential`, the one operation
 * that genuinely loses data, removes a reference. Retention purging on save goes through
 * the same path and so is safe by construction.
 *
 * ## Counting metas, not records
 *
 * The count is the number of `AttachmentMeta` entries pointing at the chunk. Within a
 * single record those are the same number, because `assertAttachmentIdsUnique` forbids two
 * metas on one record from sharing an id — see the note on that in `store.ts`. Counting
 * metas is still the right definition, because it is the thing being removed: detaching one
 * attachment decrements by exactly one, and the boundary that matters is whether that
 * reaches zero.
 */

/** Every attachment meta in the document, including trashed records. Order is stable. */
export function collectAttachmentMetas(document: VaultDocument): AttachmentMeta[] {
  return document.records.flatMap((record) => [...record.attachments]);
}

/** How many attachments point at each chunk id. Absent from the map means zero. */
export function chunkReferenceCounts(document: VaultDocument): Map<string, number> {
  const counts = new Map<string, number>();
  for (const meta of collectAttachmentMetas(document)) {
    counts.set(meta.id, (counts.get(meta.id) ?? 0) + 1);
  }
  return counts;
}

/** Chunk ids at least one attachment points at. */
export function referencedChunkIds(document: VaultDocument): Set<string> {
  return new Set(collectAttachmentMetas(document).map((meta) => meta.id));
}

/**
 * The bytes distinct chunks occupy, per the metadata.
 *
 * **Distinct** is the load-bearing word: a file attached to five records is stored once, so
 * counting it five times would refuse a vault that is nowhere near its limit. Sizes come
 * from the metadata rather than from the chunks, so this can be computed on a document
 * alone — which is what the add path needs, before the new chunk exists.
 *
 * Where two metas disagree about the size of the same chunk — only reachable after a merge
 * of two vaults that both edited the metadata — the larger wins, so the estimate errs
 * towards refusing rather than towards overrunning the cap.
 */
export function distinctAttachmentBytes(metas: readonly AttachmentMeta[]): number {
  const sizes = new Map<string, number>();
  for (const meta of metas) {
    sizes.set(meta.id, Math.max(sizes.get(meta.id) ?? 0, meta.size));
  }

  let total = 0;
  for (const size of sizes.values()) total += size;
  return total;
}

/**
 * The chunks that would be left unreferenced if this record were permanently deleted.
 *
 * This is what `purgeCredential` needs, and getting it wrong in the obvious direction —
 * dropping every chunk the record lists — deletes files other records are still using.
 * Returns ids in the record's own order, deduplicated.
 */
export function chunkIdsOrphanedBy(document: VaultDocument, credentialId: string): string[] {
  const counts = chunkReferenceCounts(document);
  const record = document.records.find((candidate) => candidate.id === credentialId);
  if (record === undefined) return [];

  const orphaned: string[] = [];
  const seen = new Set<string>();
  for (const meta of record.attachments) {
    if (seen.has(meta.id)) continue;
    seen.add(meta.id);

    // Every reference this record holds is about to disappear, so the chunk survives only
    // if some *other* record also points at it.
    const held = record.attachments.filter((entry) => entry.id === meta.id).length;
    if ((counts.get(meta.id) ?? 0) - held <= 0) orphaned.push(meta.id);
  }
  return orphaned;
}

/**
 * Whether removing one attachment from one record leaves its chunk unreferenced.
 *
 * The single boundary the whole design turns on: with two referrers the answer is `false`
 * and the chunk stays; with one it is `true` and the chunk may go.
 */
export function wouldOrphanChunk(
  document: VaultDocument,
  credentialId: string,
  chunkId: string
): boolean {
  const counts = chunkReferenceCounts(document);
  const record = document.records.find((candidate) => candidate.id === credentialId);
  if (record === undefined) return false;
  if (!record.attachments.some((meta) => meta.id === chunkId)) return false;

  return (counts.get(chunkId) ?? 0) <= 1;
}

/** Records holding at least one attachment. Used by the audit and by vault statistics. */
export function recordsWithAttachments(document: VaultDocument): readonly Credential[] {
  return document.records.filter((record) => record.attachments.length > 0);
}
