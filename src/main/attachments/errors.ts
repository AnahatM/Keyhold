// SPDX-License-Identifier: GPL-3.0-or-later
import type { AttachmentErrorCode } from '@shared/model/attachment.js';

/**
 * Errors for the attachment engine.
 *
 * A separate class from `VaultError` on purpose. `VaultError`'s codes describe a *file* —
 * not a vault, wrong password, tampered, malformed — and are what the unlock screen
 * branches on. These describe a *refused operation* on an open vault, which is a different
 * conversation with the user and a different set of buttons.
 *
 * ## The one rule
 *
 * **A message names limits, sizes and chunk ids. Never a filename, never a byte of
 * content, never a path.** An attachment can be a photograph of a passport; its filename
 * is frequently `Passport - Jane Doe.jpg`, which is personal data in its own right. Errors
 * get logged, screenshotted and pasted into bug reports, so anything in one is public.
 * Chunk ids are safe because they are random — see `random.ts`, which deliberately does
 * *not* derive them from content.
 *
 * `no-leak.test.ts` asserts this with a property test rather than trusting this comment.
 */
export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;

  constructor(code: AttachmentErrorCode, message: string) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
  }
}

export function attachmentTooLarge(size: number, limit: number): AttachmentError {
  return new AttachmentError(
    'ATTACHMENT_TOO_LARGE',
    `This file is ${size} bytes, above the ${limit}-byte limit for a single attachment. Raise the limit in settings, or attach a smaller file.`
  );
}

export function vaultAttachmentLimit(
  wouldBe: number,
  limit: number,
  size: number
): AttachmentError {
  return new AttachmentError(
    'VAULT_ATTACHMENT_LIMIT',
    `Adding ${size} bytes would bring this vault's attachments to ${wouldBe} bytes, above the ${limit}-byte total. Remove an attachment, or raise the limit in settings.`
  );
}

export function tooManyAttachments(limit: number): AttachmentError {
  return new AttachmentError(
    'TOO_MANY_ATTACHMENTS',
    `A record may hold at most ${limit} attachments.`
  );
}

export function emptyAttachment(): AttachmentError {
  return new AttachmentError(
    'EMPTY_ATTACHMENT',
    'That file is empty, so there is nothing to store.'
  );
}

export function duplicateAttachmentId(chunkId: string): AttachmentError {
  return new AttachmentError(
    'DUPLICATE_ATTACHMENT_ID',
    `Two attachments on one record both point at chunk ${chunkId}. Reveal and download address an attachment by that id, so a duplicate would return the wrong file.`
  );
}

export function chunkIdCollision(chunkId: string): AttachmentError {
  return new AttachmentError(
    'DUPLICATE_ATTACHMENT_ID',
    `Chunk ${chunkId} is already stored in this vault, so it cannot be the id of a new attachment. Supply a fresh id from randomChunkId().`
  );
}

export function noSuchAttachment(chunkId: string): AttachmentError {
  return new AttachmentError('NO_SUCH_ATTACHMENT', `This record has no attachment ${chunkId}.`);
}

export function noSuchRecord(credentialId: string): AttachmentError {
  return new AttachmentError('NO_SUCH_RECORD', `No record with id ${credentialId}.`);
}

export function invalidAttachmentLimit(detail: string): AttachmentError {
  return new AttachmentError('INVALID_ATTACHMENT_LIMIT', `Unusable attachment limit: ${detail}`);
}

export function attachmentIntegrity(chunkId: string): AttachmentError {
  return new AttachmentError(
    'ATTACHMENT_INTEGRITY',
    `Attachment ${chunkId} did not match the digest recorded when it was stored. It has been altered or corrupted, and was not returned.`
  );
}
