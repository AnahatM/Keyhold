// SPDX-License-Identifier: GPL-3.0-or-later
import type { AttachmentChunk } from '@shared/format/types.js';
import type { AttachmentAudit, AttachmentIssue } from '@shared/model/attachment.js';
import type { AttachmentMeta } from '@shared/model/credential.js';
import type { VaultDocument } from '@shared/model/vault-document.js';
import { digestsMatch, sha256Hex } from './digest.js';
import { attachmentIntegrity } from './errors.js';
import {
  collectAttachmentMetas,
  distinctAttachmentBytes,
  recordsWithAttachments,
  referencedChunkIds,
} from './references.js';

/**
 * Reconciling the metadata against the chunks that are actually in the file.
 *
 * A `Credential` says which chunks it has; the container says which chunks exist. Those two
 * lists are written together and can still come apart, in both directions:
 *
 *  - **A chunk nobody references.** A merge that resolved in favour of a version without an
 *    attachment, or a record purged by a build that dropped the metadata but not the bytes.
 *    Costs space and nothing else, but the space is real and invisible.
 *  - **A meta with no chunk.** A partial restore from a backup written before the file was
 *    attached, or a hand-assembled vault. The record advertises an attachment the user
 *    cannot open, which is the worse of the two because it looks like a bug in the reader.
 *
 * ## Reported, never silently repaired
 *
 * This function returns findings and changes nothing. Both directions look like damage and
 * neither has an obviously correct automatic fix — deleting an unreferenced chunk destroys
 * the only copy of a file whose metadata may be recoverable from a backup, and dropping a
 * dangling meta throws away the name and digest that would let the user find the file
 * again. So the audit says what it found and the user decides. `unreferencedChunkIds` exists
 * for the cleanup they may then ask for, and it is a separate, explicitly-named call.
 *
 * ## What a finding may contain
 *
 * Chunk ids, record ids, and numbers. **Never a filename and never file content** — the
 * report crosses to the renderer and ends up in logs and screenshots, and an attachment's
 * name is frequently personal data in its own right.
 */
export function auditAttachments(
  document: VaultDocument,
  chunkIds: Iterable<string>,
  chunkSizes?: ReadonlyMap<string, number>
): AttachmentAudit {
  const present = new Set(chunkIds);
  const metas = collectAttachmentMetas(document);
  const issues: AttachmentIssue[] = [];

  for (const record of document.records) {
    const seen = new Set<string>();
    for (const meta of record.attachments) {
      if (seen.has(meta.id)) {
        issues.push({
          code: 'duplicate-id',
          chunkId: meta.id,
          credentialId: record.id,
          detail: 'two attachments on this record point at the same chunk',
        });
      }
      seen.add(meta.id);

      if (!present.has(meta.id)) {
        issues.push({
          code: 'missing-chunk',
          chunkId: meta.id,
          credentialId: record.id,
          detail: null,
        });
        continue;
      }

      // Only checkable when the caller supplied real chunk lengths. A size disagreement is
      // not corruption on its own — the chunk decrypted and authenticated fine — it means
      // the metadata and the bytes came from different writes, which is worth surfacing
      // before someone trusts the recorded size for anything.
      const actual = chunkSizes?.get(meta.id);
      if (actual !== undefined && actual !== meta.size) {
        issues.push({
          code: 'size-mismatch',
          chunkId: meta.id,
          credentialId: record.id,
          detail: `metadata records ${meta.size} bytes, the chunk holds ${actual}`,
        });
      }
    }
  }

  const referenced = referencedChunkIds(document);
  for (const id of present) {
    if (referenced.has(id)) continue;
    issues.push({ code: 'unreferenced-chunk', chunkId: id, credentialId: null, detail: null });
  }

  return {
    issues,
    chunkCount: present.size,
    // Referenced *and* present: a meta pointing at nothing is already reported above, and
    // counting it here would make the two halves of the report contradict each other.
    referencedCount: [...referenced].filter((id) => present.has(id)).length,
    totalBytes: distinctAttachmentBytes(metas.filter((meta) => present.has(meta.id))),
    recordsWithAttachments: recordsWithAttachments(document).length,
  };
}

/** The chunk ids an audit found nothing pointing at, in the order they were reported. */
export function unreferencedChunkIds(audit: AttachmentAudit): string[] {
  return audit.issues
    .filter((issue) => issue.code === 'unreferenced-chunk')
    .map((issue) => issue.chunkId);
}

/** The attachments an audit found no chunk for, as `[credentialId, chunkId]` pairs. */
export function missingChunkReferences(
  audit: AttachmentAudit
): readonly { readonly credentialId: string; readonly chunkId: string }[] {
  return audit.issues
    .filter((issue) => issue.code === 'missing-chunk')
    .map((issue) => ({ credentialId: issue.credentialId ?? '', chunkId: issue.chunkId }));
}

/**
 * Drops the chunks nothing points at.
 *
 * Separate from the audit and separately named, because this is the one operation here that
 * loses data. Nothing calls it as a side effect of saving; the caller must have decided to.
 */
export function pruneUnreferencedChunks(
  document: VaultDocument,
  chunks: readonly AttachmentChunk[]
): readonly AttachmentChunk[] {
  const referenced = referencedChunkIds(document);
  return chunks.filter((chunk) => referenced.has(chunk.id));
}

/**
 * Verifies chunk bytes against the digest recorded when the file was attached.
 *
 * The AES-GCM tag already proves the bytes are the ones that were encrypted. This proves
 * something the tag cannot: that they are the ones the *user attached*. The digest is taken
 * once, at attach time, before any of our own write path has touched the data — so a bug in
 * compression, framing or chunk assembly is caught here rather than being faithfully
 * authenticated all the way to the user.
 *
 * Throws rather than returning a boolean. Returning a boolean produces call sites that
 * forget to check it, and the failure mode of forgetting is handing the user the wrong file.
 */
export function assertAttachmentIntegrity(meta: AttachmentMeta, bytes: Uint8Array): void {
  if (bytes.length !== meta.size || !digestsMatch(sha256Hex(bytes), meta.sha256)) {
    throw attachmentIntegrity(meta.id);
  }
}

/** The non-throwing form, for a bulk scan that must report on every file rather than stop. */
export function attachmentMatchesDigest(meta: AttachmentMeta, bytes: Uint8Array): boolean {
  return bytes.length === meta.size && digestsMatch(sha256Hex(bytes), meta.sha256);
}
