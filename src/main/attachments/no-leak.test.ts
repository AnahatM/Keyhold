// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { assertAttachmentIntegrity, auditAttachments } from './audit.js';
import { sha256Hex } from './digest.js';
import { AttachmentError } from './errors.js';
import { resolveAttachmentLimits } from './limits.js';
import {
  addAttachment,
  addAttachmentToDocument,
  assertAttachmentIdsUnique,
  removeAttachment,
} from './store.js';
import { documentOf, metaFor, recordOf, secretOf } from './test-fixtures.js';

/**
 * **Nothing this module produces may carry file content, a filename, or a path.**
 *
 * Errors get logged, screenshotted and pasted into bug reports; the audit report crosses to
 * the renderer. An attachment can be a photograph of a passport, and its filename —
 * `Passport - Jane Doe.jpg` — is personal data on its own, before the bytes are considered.
 *
 * This is a property test rather than a comment in `errors.ts` because the failure it
 * guards against is somebody adding a helpful `${name}` to a message six months from now,
 * which reads as an improvement right up until the log leaves the machine.
 *
 * The digest is included in the forbidden list deliberately: it is derived from the content,
 * so publishing it turns "is this person storing *this* document?" into a lookup — the same
 * reason `store.ts` refuses to use it as the chunk id.
 */

const MARKER_NAME = 'PassportOfJaneDoe';
const MARKER_PATH = '/home/jane/Private Documents/';
const MARKER_BYTES = 'BYTESMARKERbytesmarker';

const HOSTILE_NAME = `${MARKER_PATH}${MARKER_NAME}.pdf.exe`;
const HOSTILE_BYTES = new Uint8Array(Buffer.from(MARKER_BYTES.repeat(8), 'utf8'));
const HOSTILE_DIGEST = sha256Hex(HOSTILE_BYTES);

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);

/** Every string that must not appear anywhere in an error message or a report. */
const FORBIDDEN = [
  MARKER_NAME,
  MARKER_PATH,
  MARKER_BYTES,
  HOSTILE_DIGEST,
  // The raw bytes in the two encodings a well-meaning "helpful detail" would reach for.
  Buffer.from(HOSTILE_BYTES).toString('hex'),
  Buffer.from(HOSTILE_BYTES).toString('base64'),
];

function expectClean(text: string): void {
  for (const forbidden of FORBIDDEN) {
    expect(text).not.toContain(forbidden);
  }
}

/** Runs `operation`, returning the message of the `AttachmentError` it must throw. */
function messageOf(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AttachmentError);
    return (error as AttachmentError).message;
  }
  throw new Error('expected the operation to throw');
}

describe('error messages', () => {
  const cases: readonly { readonly what: string; readonly run: () => unknown }[] = [
    {
      what: 'an empty file',
      run: () =>
        addAttachment(recordOf('r1'), {
          name: HOSTILE_NAME,
          mime: 'application/pdf',
          bytes: secretOf(new Uint8Array(0)),
          now: 1,
          newId: ID_A,
          existing: [],
        }),
    },
    {
      what: 'a file over the per-attachment cap',
      run: () =>
        addAttachment(recordOf('r1'), {
          name: HOSTILE_NAME,
          mime: 'application/pdf',
          bytes: secretOf(HOSTILE_BYTES),
          now: 1,
          newId: ID_A,
          existing: [],
          settings: { maxAttachmentBytes: 8, maxVaultAttachmentBytes: 8, warnAboveBytes: 4 },
        }),
    },
    {
      what: 'a file over the vault total',
      run: () =>
        addAttachment(recordOf('r1', [metaFor(HOSTILE_BYTES, { id: ID_B, size: 900 })]), {
          name: HOSTILE_NAME,
          mime: 'application/pdf',
          bytes: secretOf(HOSTILE_BYTES),
          now: 1,
          newId: ID_A,
          existing: [metaFor(HOSTILE_BYTES, { id: ID_B, size: 900 })],
          settings: { maxAttachmentBytes: 1000, maxVaultAttachmentBytes: 1000 },
        }),
    },
    {
      what: 'too many attachments on one record',
      run: () =>
        addAttachment(recordOf('r1', [metaFor(new Uint8Array([1]), { id: ID_B })]), {
          name: HOSTILE_NAME,
          mime: 'application/pdf',
          bytes: secretOf(HOSTILE_BYTES),
          now: 1,
          newId: ID_A,
          existing: [],
          settings: { maxAttachmentsPerRecord: 1 },
        }),
    },
    {
      what: 'a chunk id already in use',
      run: () =>
        addAttachment(recordOf('r1'), {
          name: HOSTILE_NAME,
          mime: 'application/pdf',
          bytes: secretOf(HOSTILE_BYTES),
          now: 1,
          newId: ID_B,
          existing: [metaFor(new Uint8Array([1]), { id: ID_B })],
        }),
    },
    {
      what: 'a record with two attachments sharing an id',
      run: () => {
        const meta = metaFor(HOSTILE_BYTES, { id: ID_A, name: HOSTILE_NAME });
        assertAttachmentIdsUnique(recordOf('r1', [meta, meta]));
      },
    },
    {
      what: 'removing an attachment that is not there',
      run: () => removeAttachment(documentOf(recordOf('r1')), 'r1', ID_A),
    },
    {
      what: 'attaching to a record that does not exist',
      run: () =>
        addAttachmentToDocument(documentOf(recordOf('r1')), 'nope', {
          name: HOSTILE_NAME,
          mime: 'application/pdf',
          bytes: secretOf(HOSTILE_BYTES),
          now: 1,
          newId: ID_A,
        }),
    },
    {
      what: 'an unusable limit',
      run: () => resolveAttachmentLimits({ maxAttachmentBytes: -1 }),
    },
    {
      what: 'a failed integrity check',
      run: () => {
        assertAttachmentIntegrity(
          metaFor(HOSTILE_BYTES, { id: ID_A, name: HOSTILE_NAME }),
          new Uint8Array(HOSTILE_BYTES.length)
        );
      },
    },
  ];

  for (const { what, run } of cases) {
    it(`says nothing it should not about ${what}`, () => {
      expectClean(messageOf(run));
    });
  }
});

describe('the audit report', () => {
  it('carries ids and numbers, never a name or a digest', () => {
    const meta = metaFor(HOSTILE_BYTES, { id: ID_A, name: HOSTILE_NAME });
    const document = documentOf(recordOf('r1', [meta, { ...meta, name: HOSTILE_NAME }]));
    const audit = auditAttachments(document, [ID_B], new Map([[ID_B, 7]]));

    // Every code this module can produce is present in this one report, so the assertion
    // covers the whole surface rather than one branch of it.
    expect(audit.issues.length).toBeGreaterThan(0);
    expectClean(JSON.stringify(audit));
  });
});
