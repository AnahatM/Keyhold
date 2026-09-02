// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTACHMENT_SETTINGS, type AttachmentSettings } from '@shared/model/attachment.js';
import { AttachmentError } from './errors.js';
import { resolveAttachmentLimits } from './limits.js';
import {
  chunkIdsOrphanedBy,
  chunkReferenceCounts,
  distinctAttachmentBytes,
  wouldOrphanChunk,
} from './references.js';
import {
  addAttachment,
  addAttachmentToDocument,
  assertAttachmentIdsUnique,
  removeAttachment,
  toContainerChunk,
  type DocumentAttachInput,
} from './store.js';
import { documentOf, metaFor, opaqueBytes, pngBytes, recordOf, secretOf } from './test-fixtures.js';

/**
 * The attachment store.
 *
 * The three things worth testing here are the three that lose data when they are wrong:
 * dedupe (which decides whether bytes are stored at all), the reference boundary (which
 * decides whether they are deleted), and the caps (which decide whether the vault stays
 * openable). Everything else in the module is plumbing.
 */

const NOW = 1_700_000_000_000;
const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);
const ID_C = 'c'.repeat(32);

/** Small, explicit caps so an "exact edge" test does not have to allocate 128 MiB. */
const TIGHT: AttachmentSettings = {
  maxAttachmentBytes: 100,
  maxVaultAttachmentBytes: 250,
  warnAboveBytes: 50,
  maxAttachmentsPerRecord: 3,
};

function attach(
  document: ReturnType<typeof documentOf>,
  credentialId: string,
  bytes: Uint8Array,
  overrides: Partial<DocumentAttachInput> = {}
): ReturnType<typeof addAttachmentToDocument> {
  return addAttachmentToDocument(document, credentialId, {
    name: 'scan.png',
    mime: 'image/png',
    bytes: secretOf(bytes),
    now: NOW,
    newId: ID_A,
    ...overrides,
  });
}

describe('the published defaults', () => {
  // The roadmap states 25 MB per file with a warning above 5 MB. A number written in prose
  // gets a test that reads it back out — otherwise the doc and the code drift silently.
  it('matches the documented caps', () => {
    expect(DEFAULT_ATTACHMENT_SETTINGS.maxAttachmentBytes).toBe(25 * 1024 * 1024);
    expect(DEFAULT_ATTACHMENT_SETTINGS.warnAboveBytes).toBe(5 * 1024 * 1024);
    expect(DEFAULT_ATTACHMENT_SETTINGS.maxVaultAttachmentBytes).toBe(128 * 1024 * 1024);
  });
});

describe('content-addressed dedupe', () => {
  it('stores one chunk when two records attach the same file', () => {
    const document = documentOf(recordOf('r1'), recordOf('r2'));
    const bytes = pngBytes(64);

    const first = attach(document, 'r1', bytes, { newId: ID_A });
    expect(first.deduped).toBe(false);
    expect(first.chunk?.id).toBe(ID_A);

    const second = attach(first.document, 'r2', bytes, { newId: ID_B, name: 'copy.png' });

    // The second attachment reuses the first's chunk, so there is nothing new to write —
    // but it keeps its own metadata, including its own name.
    expect(second.deduped).toBe(true);
    expect(second.chunk).toBeNull();
    expect(second.meta.id).toBe(ID_A);
    expect(second.meta.name).toBe('copy.png');
  });

  it('does not add a second entry when one record attaches the same file twice', () => {
    // Two metas on one record sharing a chunk id would make reveal-by-id ambiguous, which is
    // the custom-field duplicate bug in a different costume.
    const document = documentOf(recordOf('r1'));
    const bytes = pngBytes(64);

    const first = attach(document, 'r1', bytes, { newId: ID_A });
    const again = attach(first.document, 'r1', bytes, { newId: ID_B, name: 'other.png' });

    expect(again.deduped).toBe(true);
    expect(again.chunk).toBeNull();
    expect(again.document.records[0]?.attachments).toHaveLength(1);
    // The existing attachment keeps its name — re-attaching is not a rename.
    expect(again.meta.name).toBe('scan.png');
  });

  it('keeps different files apart', () => {
    const document = documentOf(recordOf('r1'));
    const first = attach(document, 'r1', pngBytes(64, 0x11), { newId: ID_A });
    const second = attach(first.document, 'r1', pngBytes(64, 0x22), { newId: ID_B });

    expect(second.deduped).toBe(false);
    expect(second.meta.id).toBe(ID_B);
    expect(second.document.records[0]?.attachments).toHaveLength(2);
  });

  it('requires the size to agree as well as the digest', () => {
    // Belt and braces against a digest that was recorded wrongly rather than against a
    // SHA-256 collision: a meta whose size does not match must not silently capture a new file.
    const bytes = pngBytes(64);
    const stale = metaFor(bytes, { id: ID_C, size: 63 });
    const document = documentOf(recordOf('r1', [stale]));

    const result = attach(document, 'r1', bytes, { newId: ID_B });
    expect(result.deduped).toBe(false);
    expect(result.meta.id).toBe(ID_B);
  });

  it('refuses a chunk id the vault is already using', () => {
    const document = documentOf(recordOf('r1', [metaFor(pngBytes(64), { id: ID_A })]));
    expect(() => attach(document, 'r1', pngBytes(64, 0x33), { newId: ID_A })).toThrow(
      AttachmentError
    );
  });
});

describe('the reference boundary', () => {
  function sharedDocument(): ReturnType<typeof documentOf> {
    const meta = metaFor(pngBytes(64), { id: ID_A });
    return documentOf(recordOf('r1', [meta]), recordOf('r2', [meta]));
  }

  it('counts every meta pointing at a chunk', () => {
    expect(chunkReferenceCounts(sharedDocument()).get(ID_A)).toBe(2);
  });

  it('keeps the chunk while one referrer remains, and releases it when the last one goes', () => {
    const document = sharedDocument();

    const first = removeAttachment(document, 'r1', ID_A);
    expect(first.chunkOrphaned).toBe(false);
    expect(first.document.records[0]?.attachments).toHaveLength(0);
    expect(first.document.records[1]?.attachments).toHaveLength(1);

    const second = removeAttachment(first.document, 'r2', ID_A);
    expect(second.chunkOrphaned).toBe(true);
  });

  it('releases a chunk with a single referrer', () => {
    const document = documentOf(recordOf('r1', [metaFor(pngBytes(64), { id: ID_A })]));
    expect(removeAttachment(document, 'r1', ID_A).chunkOrphaned).toBe(true);
  });

  it('counts a trashed record as a referrer', () => {
    // Trash is restorable. Dropping a trashed record's chunks would restore a record whose
    // attachments are gone — data loss with a delay on it.
    const meta = metaFor(pngBytes(64), { id: ID_A });
    const trashed = { ...recordOf('r2', [meta]), trashedAt: NOW };
    const document = documentOf(recordOf('r1', [meta]), trashed);

    expect(removeAttachment(document, 'r1', ID_A).chunkOrphaned).toBe(false);
    expect(wouldOrphanChunk(document, 'r1', ID_A)).toBe(false);
  });

  it('reports what a permanent delete would orphan', () => {
    const shared = metaFor(pngBytes(64), { id: ID_A });
    const own = metaFor(pngBytes(32, 0x77), { id: ID_B });
    const document = documentOf(recordOf('r1', [shared, own]), recordOf('r2', [shared]));

    // The shared chunk survives r1's deletion; the one only r1 held does not.
    expect(chunkIdsOrphanedBy(document, 'r1')).toEqual([ID_B]);
    expect(chunkIdsOrphanedBy(document, 'r2')).toEqual([]);
  });

  it('refuses to remove an attachment the record does not have', () => {
    const document = documentOf(recordOf('r1'));
    expect(() => removeAttachment(document, 'r1', ID_A)).toThrow(AttachmentError);
    expect(() => removeAttachment(document, 'nope', ID_A)).toThrow(AttachmentError);
  });
});

describe('limits, at their exact edges', () => {
  it('accepts a file of exactly the per-attachment cap and refuses one byte more', () => {
    const document = documentOf(recordOf('r1'));

    const exact = attach(document, 'r1', pngBytes(TIGHT.maxAttachmentBytes), { settings: TIGHT });
    expect(exact.meta.size).toBe(TIGHT.maxAttachmentBytes);

    expect(() =>
      attach(document, 'r1', pngBytes(TIGHT.maxAttachmentBytes + 1), { settings: TIGHT })
    ).toThrow(expect.objectContaining({ code: 'ATTACHMENT_TOO_LARGE' }));
  });

  it('accepts a vault total of exactly the cap and refuses one byte more', () => {
    // Two 100-byte files plus a 50-byte one lands exactly on 250.
    const document = documentOf(recordOf('r1'));
    const first = attach(document, 'r1', pngBytes(100, 0x11), { newId: ID_A, settings: TIGHT });
    const second = attach(first.document, 'r1', pngBytes(100, 0x22), {
      newId: ID_B,
      settings: TIGHT,
    });

    const exact = attach(second.document, 'r1', pngBytes(50, 0x33), {
      newId: ID_C,
      settings: TIGHT,
    });
    expect(distinctAttachmentBytes(exact.document.records[0]?.attachments ?? [])).toBe(250);

    expect(() =>
      attach(second.document, 'r1', pngBytes(51, 0x44), { newId: ID_C, settings: TIGHT })
    ).toThrow(expect.objectContaining({ code: 'VAULT_ATTACHMENT_LIMIT' }));
  });

  it('does not charge a deduped attachment against the vault total', () => {
    // The bytes are already stored, so a second reference costs nothing — counting it would
    // refuse an attachment that takes up no additional space at all.
    const bytes = pngBytes(200);
    const roomy: AttachmentSettings = { ...TIGHT, maxAttachmentBytes: 200 };
    const document = documentOf(recordOf('r1'), recordOf('r2'));

    const first = attach(document, 'r1', bytes, { newId: ID_A, settings: roomy });
    const second = attach(first.document, 'r2', bytes, { newId: ID_B, settings: roomy });

    expect(second.deduped).toBe(true);
    expect(second.meta.id).toBe(ID_A);
  });

  it('accepts exactly the per-record count and refuses the next', () => {
    const metas = [
      metaFor(pngBytes(16, 0x01), { id: ID_A }),
      metaFor(pngBytes(16, 0x02), { id: ID_B }),
      metaFor(pngBytes(16, 0x03), { id: ID_C }),
    ];
    const full = documentOf(recordOf('r1', metas));
    const nearlyFull = documentOf(recordOf('r1', metas.slice(0, 2)));

    expect(() =>
      attach(nearlyFull, 'r1', pngBytes(16, 0x04), { newId: 'd'.repeat(32), settings: TIGHT })
    ).not.toThrow();
    expect(() =>
      attach(full, 'r1', pngBytes(16, 0x04), { newId: 'd'.repeat(32), settings: TIGHT })
    ).toThrow(expect.objectContaining({ code: 'TOO_MANY_ATTACHMENTS' }));
  });

  it('warns above the threshold and not at it', () => {
    const document = documentOf(recordOf('r1'));
    expect(
      attach(document, 'r1', pngBytes(TIGHT.warnAboveBytes), { settings: TIGHT }).warnLarge
    ).toBe(false);
    expect(
      attach(document, 'r1', pngBytes(TIGHT.warnAboveBytes + 1), { settings: TIGHT }).warnLarge
    ).toBe(true);
  });

  it('refuses an empty file', () => {
    const document = documentOf(recordOf('r1'));
    expect(() => attach(document, 'r1', new Uint8Array(0))).toThrow(
      expect.objectContaining({ code: 'EMPTY_ATTACHMENT' })
    );
  });

  it('refuses a cap the container could not read back', () => {
    expect(() => resolveAttachmentLimits({ maxAttachmentBytes: 268_435_457 })).toThrow(
      expect.objectContaining({ code: 'INVALID_ATTACHMENT_LIMIT' })
    );
    // A total below the per-file cap makes the per-file cap a promise that cannot be kept.
    expect(() =>
      resolveAttachmentLimits({ maxAttachmentBytes: 1000, maxVaultAttachmentBytes: 999 })
    ).toThrow(expect.objectContaining({ code: 'INVALID_ATTACHMENT_LIMIT' }));
    expect(() => resolveAttachmentLimits({ maxAttachmentBytes: 0 })).toThrow(AttachmentError);
  });

  it('clamps a warning threshold above the cap rather than refusing to open the vault', () => {
    expect(
      resolveAttachmentLimits({ maxAttachmentBytes: 100, warnAboveBytes: 5000 }).warnAboveBytes
    ).toBe(100);
  });
});

describe('the plaintext bytes', () => {
  it('hands ownership to the pending chunk when the file is new', () => {
    const secret = secretOf(pngBytes(64));
    const result = addAttachment(recordOf('r1'), {
      name: 'scan.png',
      mime: 'image/png',
      bytes: secret,
      now: NOW,
      newId: ID_A,
      existing: [],
    });

    expect(secret.destroyed).toBe(false);
    expect(result.chunk?.data).toBe(secret);

    // Handing the chunk to the container consumes it: from there the plaintext exists once,
    // in the buffer about to be encrypted.
    const chunk = toContainerChunk(result.chunk!);
    expect(chunk.data).toHaveLength(64);
    expect(secret.destroyed).toBe(true);
  });

  it('destroys them when the file was already in the vault', () => {
    const bytes = pngBytes(64);
    const document = documentOf(recordOf('r1', [metaFor(bytes, { id: ID_A })]));
    const secret = secretOf(bytes);

    addAttachmentToDocument(document, 'r1', {
      name: 'scan.png',
      mime: 'image/png',
      bytes: secret,
      now: NOW,
      newId: ID_B,
    });

    expect(secret.destroyed).toBe(true);
  });

  it('destroys them when the operation is refused', () => {
    // The error path is where things go wrong, which is exactly when a stray copy of a
    // photographed passport matters.
    const secret = secretOf(pngBytes(500));
    expect(() =>
      addAttachment(recordOf('r1'), {
        name: 'scan.png',
        mime: 'image/png',
        bytes: secret,
        now: NOW,
        newId: ID_A,
        existing: [],
        settings: TIGHT,
      })
    ).toThrow(AttachmentError);

    expect(secret.destroyed).toBe(true);
  });

  it('destroys them when the record does not exist', () => {
    const secret = secretOf(pngBytes(64));
    expect(() =>
      addAttachmentToDocument(documentOf(recordOf('r1')), 'missing', {
        name: 'scan.png',
        mime: 'image/png',
        bytes: secret,
        now: NOW,
        newId: ID_A,
      })
    ).toThrow(expect.objectContaining({ code: 'NO_SUCH_RECORD' }));
    expect(secret.destroyed).toBe(true);
  });
});

describe('metadata', () => {
  it('stores the detected type, not the claimed one', () => {
    const document = documentOf(recordOf('r1'));
    const result = attach(document, 'r1', pngBytes(64), { mime: 'application/pdf' });

    expect(result.mime.status).toBe('mismatch');
    expect(result.mime.claimed).toBe('application/pdf');
    expect(result.meta.mime).toBe('image/png');
  });

  it('stores the sanitised name, never the path it arrived with', () => {
    const document = documentOf(recordOf('r1'));
    const result = attach(document, 'r1', pngBytes(64), { name: '../../../etc/passwd' });

    expect(result.meta.name).toBe('passwd');
    expect(result.name.changed).toBe(true);
  });

  it('records the digest of what was actually stored', () => {
    const document = documentOf(recordOf('r1'));
    const bytes = opaqueBytes(40, 0x5a);
    const result = attach(document, 'r1', bytes, { mime: 'application/octet-stream' });

    expect(result.meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.meta.size).toBe(40);
    expect(result.meta.addedAt).toBe(NOW);
  });

  it('refuses a record whose attachments share an id', () => {
    const meta = metaFor(pngBytes(16), { id: ID_A });
    expect(() => {
      assertAttachmentIdsUnique(recordOf('r1', [meta, meta]));
    }).toThrow(expect.objectContaining({ code: 'DUPLICATE_ATTACHMENT_ID' }));
  });

  it('leaves the original document untouched', () => {
    const document = documentOf(recordOf('r1'));
    attach(document, 'r1', pngBytes(64));
    expect(document.records[0]?.attachments).toHaveLength(0);
  });
});
