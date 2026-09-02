// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The attachment engine: pure main-process logic for putting files in a vault.
 *
 * Nothing under this folder reads a file, opens a dialog, or registers an IPC channel. The
 * caller hands over bytes and gets back the record to store and the chunk to write, which
 * is what lets the parts that are easy to get wrong — the dedupe, the reference boundary,
 * the caps — be tested without an unlocked vault.
 *
 * Start with `store.ts`; the reasoning behind the design is in its module comment.
 */

export {
  assertAttachmentIntegrity,
  attachmentMatchesDigest,
  auditAttachments,
  missingChunkReferences,
  pruneUnreferencedChunks,
  unreferencedChunkIds,
} from './audit.js';
export { digestsMatch, sha256Hex } from './digest.js';
export {
  AttachmentError,
  attachmentIntegrity,
  attachmentTooLarge,
  chunkIdCollision,
  duplicateAttachmentId,
  emptyAttachment,
  invalidAttachmentLimit,
  noSuchAttachment,
  noSuchRecord,
  tooManyAttachments,
  vaultAttachmentLimit,
} from './errors.js';
export {
  checkAttachmentName,
  hasExecutableExtension,
  looksDisguised,
  sanitiseAttachmentName,
} from './filename.js';
export { resolveAttachmentLimits } from './limits.js';
export {
  chunkIdsOrphanedBy,
  chunkReferenceCounts,
  collectAttachmentMetas,
  distinctAttachmentBytes,
  recordsWithAttachments,
  referencedChunkIds,
  wouldOrphanChunk,
} from './references.js';
export { checkMimeClaim, normaliseMimeClaim, previewKindForMime, sniffFormat } from './sniff.js';
export type { SniffedFormat } from './sniff.js';
export {
  addAttachment,
  addAttachmentToDocument,
  adoptAttachmentBytes,
  assertAttachmentIdsUnique,
  releasePendingChunk,
  removeAttachment,
  toContainerChunk,
} from './store.js';
export type {
  AddAttachmentInput,
  AddAttachmentResult,
  DocumentAttachInput,
  DocumentAttachResult,
  PendingAttachmentChunk,
  RemoveAttachmentResult,
} from './store.js';
