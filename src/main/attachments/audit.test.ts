// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  assertAttachmentIntegrity,
  attachmentMatchesDigest,
  auditAttachments,
  missingChunkReferences,
  pruneUnreferencedChunks,
  unreferencedChunkIds,
} from './audit.js';
import { documentOf, metaFor, pngBytes, recordOf } from './test-fixtures.js';

/**
 * The audit.
 *
 * Both directions of drift are real after a merge or a partial restore, and neither is
 * repaired here — the tests care as much about what the audit *does not* do as about what
 * it finds.
 */

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);
const ID_C = 'c'.repeat(32);

describe('orphans, both directions', () => {
  it('reports a chunk nothing points at', () => {
    const document = documentOf(recordOf('r1', [metaFor(pngBytes(16), { id: ID_A })]));
    const audit = auditAttachments(document, [ID_A, ID_B]);

    expect(unreferencedChunkIds(audit)).toEqual([ID_B]);
    expect(audit.chunkCount).toBe(2);
    expect(audit.referencedCount).toBe(1);
  });

  it('reports an attachment whose chunk is gone', () => {
    const document = documentOf(recordOf('r1', [metaFor(pngBytes(16), { id: ID_A })]));
    const audit = auditAttachments(document, []);

    expect(missingChunkReferences(audit)).toEqual([{ credentialId: 'r1', chunkId: ID_A }]);
    // A meta pointing at nothing must not also be counted as referencing something, or the
    // two halves of the report contradict each other.
    expect(audit.referencedCount).toBe(0);
    expect(audit.totalBytes).toBe(0);
  });

  it('reports both at once, which is what a bad merge actually looks like', () => {
    const document = documentOf(recordOf('r1', [metaFor(pngBytes(16), { id: ID_A })]));
    const audit = auditAttachments(document, [ID_B]);

    expect(audit.issues.map((issue) => issue.code).sort()).toEqual([
      'missing-chunk',
      'unreferenced-chunk',
    ]);
  });

  it('finds nothing when the two sides agree', () => {
    const meta = metaFor(pngBytes(16), { id: ID_A });
    const document = documentOf(recordOf('r1', [meta]), recordOf('r2', [meta]));
    const audit = auditAttachments(document, [ID_A]);

    expect(audit.issues).toEqual([]);
    // Shared by two records, stored once, counted once.
    expect(audit.referencedCount).toBe(1);
    expect(audit.totalBytes).toBe(16);
    expect(audit.recordsWithAttachments).toBe(2);
  });

  it('reports two attachments on one record sharing a chunk id', () => {
    const meta = metaFor(pngBytes(16), { id: ID_A });
    const document = documentOf(recordOf('r1', [meta, { ...meta, name: 'other.png' }]));
    const audit = auditAttachments(document, [ID_A]);

    expect(audit.issues.map((issue) => issue.code)).toEqual(['duplicate-id']);
  });

  it('reports a chunk whose length is not what the metadata recorded', () => {
    const document = documentOf(recordOf('r1', [metaFor(pngBytes(16), { id: ID_A })]));
    const audit = auditAttachments(document, [ID_A], new Map([[ID_A, 99]]));

    const issue = audit.issues[0];
    expect(issue?.code).toBe('size-mismatch');
    expect(issue?.detail).toContain('99');
  });

  it('changes nothing', () => {
    // Both directions look like damage and neither has an obviously correct automatic fix,
    // so the audit reports and the user decides.
    const document = documentOf(recordOf('r1', [metaFor(pngBytes(16), { id: ID_A })]));
    const before = JSON.stringify(document);

    auditAttachments(document, [ID_B, ID_C]);
    expect(JSON.stringify(document)).toBe(before);
  });
});

describe('pruning', () => {
  it('keeps every referenced chunk and drops the rest', () => {
    const document = documentOf(recordOf('r1', [metaFor(pngBytes(16), { id: ID_A })]));
    const chunks = [
      { id: ID_A, data: pngBytes(16) },
      { id: ID_B, data: pngBytes(8) },
    ];

    expect(pruneUnreferencedChunks(document, chunks).map((chunk) => chunk.id)).toEqual([ID_A]);
  });

  it('keeps a chunk a trashed record still points at', () => {
    const meta = metaFor(pngBytes(16), { id: ID_A });
    const trashed = { ...recordOf('r1', [meta]), trashedAt: 1_700_000_000_000 };
    const chunks = [{ id: ID_A, data: pngBytes(16) }];

    expect(pruneUnreferencedChunks(documentOf(trashed), chunks)).toHaveLength(1);
  });
});

describe('integrity', () => {
  it('accepts the bytes that were attached', () => {
    const bytes = pngBytes(64);
    expect(() => {
      assertAttachmentIntegrity(metaFor(bytes), bytes);
    }).not.toThrow();
    expect(attachmentMatchesDigest(metaFor(bytes), bytes)).toBe(true);
  });

  it('rejects a single flipped bit', () => {
    // The GCM tag proves these are the bytes that were encrypted. The digest proves they are
    // the bytes the user attached — which also catches a bug in our own write path.
    const bytes = pngBytes(64);
    const meta = metaFor(bytes);
    const altered = Uint8Array.from(bytes);
    altered[32] = (altered[32] ?? 0) ^ 0x01;

    expect(() => {
      assertAttachmentIntegrity(meta, altered);
    }).toThrow(expect.objectContaining({ code: 'ATTACHMENT_INTEGRITY' }));
    expect(attachmentMatchesDigest(meta, altered)).toBe(false);
  });

  it('rejects a truncated chunk', () => {
    const bytes = pngBytes(64);
    expect(() => {
      assertAttachmentIntegrity(metaFor(bytes), bytes.subarray(0, 63));
    }).toThrow(expect.objectContaining({ code: 'ATTACHMENT_INTEGRITY' }));
  });
});
