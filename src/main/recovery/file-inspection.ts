// SPDX-License-Identifier: GPL-3.0-or-later
import {
  CHUNK_ID_BYTES,
  FORMAT_VERSION,
  LENGTH_FIELD_BYTES,
  MAGIC,
  MAGIC_LENGTH,
  MAX_BODY_BYTES,
  MAX_CHUNK_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
  VERSION_FIELD_BYTES,
  type KeepHeader,
} from '@shared/format/types.js';
import {
  DIAGNOSTICS,
  type ChunkFraming,
  type ContainerLayout,
  type DiagnosticIssue,
  type FileDiagnosticCode,
  type HeaderSummary,
  type InspectionStage,
  type InspectionStop,
  type VaultFileInspection,
} from '@shared/model/recovery.js';
import { assertUsableKdfParams } from '../crypto/kdf.js';
import { parseHeader } from '../format/header.js';
import { formatCount, sanitiseDetail } from './text.js';

/**
 * How far a `.keep` file parses **without a password**, and exactly where it stops.
 *
 * ## Why this is not `readContainer`
 *
 * The reader's job is to refuse: the first thing wrong with a file is a thrown `VaultError`
 * and nothing after it is examined, which is correct, because continuing to read a damaged
 * container is how a truncated vault gets half-loaded and then saved over. This function's
 * job is the opposite one — to walk as far as it can, note every finding, and report the
 * boundary in bytes. A user whose vault will not open is not helped by "could not open
 * file"; they are helped by "the header is intact but the body is truncated at 4,096 bytes",
 * because that sentence says *what happened* — a crash, a full disk, a half-synced cloud
 * folder — and points at the backup that will not have it.
 *
 * So the walk is deliberately separate from the reader, and everything it can share with the
 * reader it does share: the field widths and ceilings come from `@shared/format/types.ts`,
 * the header is validated by `parseHeader`, and the Argon2 bounds by `assertUsableKdfParams`.
 * The only thing written twice is the traversal, because the two traversals answer different
 * questions.
 *
 * ## It reads bytes and nothing else
 *
 * No filesystem, no clock, no key, no password. It is handed the bytes and returns an
 * observation, which is what lets the fault-injection tests build damaged containers in
 * memory from a real one.
 *
 * ## It never claims a file will open
 *
 * `structurallyIntact` means every length, offset and framing rule checked out. It is not a
 * promise that the contents decrypt: authentication happens under the data key, which does
 * not exist until someone types the master password. The `verdict` says so in words, because
 * a green tick that means less than the user thinks it means is worse than no tick.
 */

/** A bounds-checked cursor that returns `null` instead of throwing. */
class Cursor {
  #offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.bytes.length - this.#offset;
  }

  take(length: number): Uint8Array | null {
    if (length < 0 || length > this.remaining) return null;
    const slice = this.bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return slice;
  }

  uint16(): number | null {
    const slice = this.take(VERSION_FIELD_BYTES);
    return slice === null ? null : Buffer.from(slice).readUInt16LE(0);
  }

  uint32(): number | null {
    const slice = this.take(LENGTH_FIELD_BYTES);
    return slice === null ? null : Buffer.from(slice).readUInt32LE(0);
  }
}

/** The smallest a sealed region can be: a nonce, an empty ciphertext, and a tag. */
const SEALED_MINIMUM_BYTES = NONCE_BYTES + TAG_BYTES;

/** Fixed by the format: magic, version, header length. The header starts here. */
const HEADER_OFFSET = MAGIC_LENGTH + VERSION_FIELD_BYTES + LENGTH_FIELD_BYTES;

/** id + length + the smallest possible sealed payload. */
const CHUNK_MINIMUM_BYTES = CHUNK_ID_BYTES + LENGTH_FIELD_BYTES + SEALED_MINIMUM_BYTES;

function issueFor(code: FileDiagnosticCode, detail: string | null): DiagnosticIssue {
  return {
    code,
    severity: DIAGNOSTICS[code].severity,
    subject: 'file',
    subjectId: null,
    credentialId: null,
    detail,
  };
}

/** The header, reduced to what a shareable report may repeat. No salt, no wrapped key. */
function summariseHeader(header: KeepHeader): HeaderSummary {
  const base64Bytes = (value: string): number => Buffer.from(value, 'base64').length;
  return {
    formatVersion: header.formatVersion,
    vaultId: header.vaultId,
    deviceId: header.deviceId,
    cipher: header.cipher,
    kdf: {
      memoryKib: header.kdf.memoryKib,
      iterations: header.kdf.iterations,
      parallelism: header.kdf.parallelism,
      saltBytes: base64Bytes(header.kdf.salt),
    },
    wrappedDekBytes: {
      nonce: base64Bytes(header.wrappedDek.nonce),
      ciphertext: base64Bytes(header.wrappedDek.ciphertext),
      tag: base64Bytes(header.wrappedDek.tag),
    },
    createdAt: header.createdAt,
    modifiedAt: header.modifiedAt,
    generation: header.generation,
    recordCount: header.recordCount,
    attachmentCount: header.attachmentCount,
  };
}

export function inspectVaultFile(bytes: Uint8Array): VaultFileInspection {
  const issues: DiagnosticIssue[] = [];
  const chunks: ChunkFraming[] = [];
  const cursor = new Cursor(bytes);

  let reached: InspectionStage | null = null;
  let stop: InspectionStop | null = null;
  let header: HeaderSummary | null = null;

  let headerLength = 0;
  let declaredBodyLength: number | null = null;
  let bodyOffset: number | null = null;
  let chunkCountOffset: number | null = null;
  let declaredChunkCount: number | null = null;

  const halt = (
    stage: InspectionStage,
    offset: number,
    expectedBytes: number | null,
    availableBytes: number,
    meaning: string
  ): void => {
    stop = { stage, offset, expectedBytes, availableBytes, meaning };
  };

  const layoutSoFar = (): ContainerLayout | null =>
    reached === null || reached === 'magic' || reached === 'format-version'
      ? null
      : {
          headerOffset: HEADER_OFFSET,
          headerLength,
          bodyLengthOffset: HEADER_OFFSET + headerLength,
          declaredBodyLength,
          bodyOffset,
          chunkCountOffset,
          declaredChunkCount,
          trailingBytes: stop === null ? cursor.remaining : 0,
        };

  const finish = (): VaultFileInspection => ({
    sizeBytes: bytes.length,
    reachedStage: reached,
    stoppedAt: stop,
    header,
    layout: layoutSoFar(),
    chunks,
    issues,
    structurallyIntact: stop === null,
    verdict: verdictFor(stop, issues.length),
  });

  // ── The signature ──────────────────────────────────────────────────────────

  if (bytes.length === 0) {
    issues.push(issueFor('file-empty', null));
    halt('magic', 0, MAGIC_LENGTH, 0, DIAGNOSTICS['file-empty'].meaning);
    return finish();
  }

  const magic = cursor.take(MAGIC_LENGTH);
  if (magic === null) {
    issues.push(issueFor('file-too-short', `the file is ${formatCount(bytes.length)} bytes`));
    halt(
      'magic',
      0,
      MAGIC_LENGTH,
      bytes.length,
      `The file is ${formatCount(bytes.length)} bytes, and a KEEP file needs at least ${formatCount(MAGIC_LENGTH)} for its signature alone. It was truncated almost immediately, or it is not a vault.`
    );
    return finish();
  }

  if (!magic.every((byte, index) => byte === MAGIC[index])) {
    // A run of zeroes where the signature should be is worth calling out separately: it is
    // what a sparse file, a failed cloud sync, or a power loss during allocation leaves,
    // and it means something quite different from "you picked the wrong file".
    const allZero = magic.every((byte) => byte === 0);
    issues.push(issueFor('not-a-vault', allZero ? 'the first 8 bytes are all zero' : null));
    halt(
      'magic',
      0,
      MAGIC_LENGTH,
      MAGIC_LENGTH,
      allZero
        ? 'The first 8 bytes are all zero rather than the KEEP signature. A zero-filled head is what a sparse file, an interrupted allocation, or a failed cloud sync leaves behind — the rest of the file may still hold data, but nothing here can locate it without the signature.'
        : DIAGNOSTICS['not-a-vault'].meaning
    );
    return finish();
  }
  reached = 'magic';

  // ── The version ────────────────────────────────────────────────────────────

  const version = cursor.uint16();
  if (version === null) {
    issues.push(issueFor('file-too-short', `the file is ${formatCount(bytes.length)} bytes`));
    halt(
      'format-version',
      MAGIC_LENGTH,
      VERSION_FIELD_BYTES,
      cursor.remaining,
      `The signature is present but the file ends inside the version field, ${formatCount(bytes.length)} bytes in. Only the signature was ever written.`
    );
    return finish();
  }

  if (version < 1) {
    issues.push(issueFor('invalid-version', `the preamble declares version ${version}`));
    halt(
      'format-version',
      MAGIC_LENGTH,
      null,
      VERSION_FIELD_BYTES,
      `The preamble declares format version ${version}, which no Keyhold has written. Those two bytes were overwritten.`
    );
    return finish();
  }

  if (version > FORMAT_VERSION) {
    // Stop here deliberately rather than parsing on under version 1's rules. The layout of a
    // future format is not ours to guess at, and a confident "your body is truncated" derived
    // from the wrong layout would send someone to restore a backup over a perfectly good file.
    issues.push(
      issueFor(
        'unsupported-version',
        `the file declares version ${version}, this build reads ${FORMAT_VERSION}`
      )
    );
    halt(
      'format-version',
      MAGIC_LENGTH,
      null,
      cursor.remaining,
      `This file was written by a newer Keyhold: it declares format version ${version} and this build understands up to ${FORMAT_VERSION}. Nothing beyond this point is interpreted, because the layout of a format this build does not know is not something to guess at. The file has not been modified — update Keyhold and open it again.`
    );
    return finish();
  }
  reached = 'format-version';

  // ── The header ─────────────────────────────────────────────────────────────

  const declaredHeaderLength = cursor.uint32();
  if (declaredHeaderLength === null) {
    issues.push(issueFor('header-truncated', null));
    halt(
      'header-length',
      MAGIC_LENGTH + VERSION_FIELD_BYTES,
      LENGTH_FIELD_BYTES,
      cursor.remaining,
      `The file ends inside the header-length field, ${formatCount(bytes.length)} bytes in. Only the preamble was written.`
    );
    return finish();
  }
  headerLength = declaredHeaderLength;
  reached = 'header-length';

  const headerBytes = cursor.take(headerLength);
  if (headerBytes === null) {
    issues.push(
      issueFor(
        'header-truncated',
        `declared ${formatCount(headerLength)} bytes, ${formatCount(cursor.remaining)} available`
      )
    );
    halt(
      'header-bytes',
      HEADER_OFFSET,
      headerLength,
      cursor.remaining,
      `The file declares a ${formatCount(headerLength)}-byte header and only ${formatCount(cursor.remaining)} bytes follow. The write was interrupted while the header was going down, so essentially none of the vault reached the disk.`
    );
    return finish();
  }
  reached = 'header-bytes';

  let parsed: KeepHeader;
  try {
    parsed = parseHeader(headerBytes);
  } catch (error) {
    // The message is safe to repeat: `parseHeader` quotes its own field-name literals and,
    // in two cases, an algorithm identifier read from a header that is plaintext by design.
    // See `sanitiseDetail` for the full reasoning.
    issues.push(
      issueFor('header-unreadable', error instanceof Error ? sanitiseDetail(error.message) : null)
    );
    halt(
      'header-json',
      HEADER_OFFSET,
      headerLength,
      headerLength,
      `The ${formatCount(headerLength)} header bytes are all present but do not parse as a KEEP header. Without them there are no key-derivation parameters, so this file cannot be unlocked even with the right password. A backup is the only route.`
    );
    return finish();
  }

  header = summariseHeader(parsed);
  reached = 'header-json';

  if (parsed.formatVersion !== version) {
    // Not a stop: the rest of the layout is still readable and worth reporting on. But it is
    // critical, because the version is stored twice precisely so this is detectable.
    issues.push(
      issueFor(
        'version-disagreement',
        `preamble says ${version}, header says ${parsed.formatVersion}`
      )
    );
  }

  try {
    assertUsableKdfParams(parsed.kdf);
  } catch (error) {
    issues.push(
      issueFor('kdf-out-of-range', error instanceof Error ? sanitiseDetail(error.message) : null)
    );
  }

  // ── The body ───────────────────────────────────────────────────────────────

  const bodyLengthOffset = cursor.offset;
  const bodyLength = cursor.uint32();
  if (bodyLength === null) {
    issues.push(issueFor('body-truncated', 'the body length field is not present'));
    halt(
      'body-length',
      bodyLengthOffset,
      LENGTH_FIELD_BYTES,
      cursor.remaining,
      `The header is intact and the file ends immediately after it, ${formatCount(bytes.length)} bytes in. The encrypted body was never written.`
    );
    return finish();
  }
  declaredBodyLength = bodyLength;
  bodyOffset = cursor.offset;
  reached = 'body-length';

  if (bodyLength > MAX_BODY_BYTES) {
    issues.push(
      issueFor(
        'body-length-implausible',
        `declared ${formatCount(bodyLength)} bytes, ceiling is ${formatCount(MAX_BODY_BYTES)}`
      )
    );
    halt(
      'body-length',
      bodyLengthOffset,
      bodyLength,
      cursor.remaining,
      `The body length field declares ${formatCount(bodyLength)} bytes, above the ${formatCount(MAX_BODY_BYTES)}-byte ceiling. Those four bytes are corrupt — no vault this app wrote can be that large.`
    );
    return finish();
  }

  if (bodyLength < SEALED_MINIMUM_BYTES) {
    issues.push(
      issueFor(
        'body-length-implausible',
        `declared ${formatCount(bodyLength)} bytes, minimum is ${formatCount(SEALED_MINIMUM_BYTES)}`
      )
    );
    halt(
      'body-length',
      bodyLengthOffset,
      bodyLength,
      cursor.remaining,
      `The body length field declares ${formatCount(bodyLength)} bytes. A sealed region is at least ${formatCount(SEALED_MINIMUM_BYTES)} — a ${formatCount(NONCE_BYTES)}-byte nonce and a ${formatCount(TAG_BYTES)}-byte tag — so those four bytes are corrupt.`
    );
    return finish();
  }

  const body = cursor.take(bodyLength);
  if (body === null) {
    const available = cursor.remaining;
    issues.push(
      issueFor(
        'body-truncated',
        `declared ${formatCount(bodyLength)} bytes, ${formatCount(available)} available`
      )
    );
    halt(
      'body-bytes',
      bodyOffset,
      bodyLength,
      available,
      `The header is intact but the body is truncated: it declares ${formatCount(bodyLength)} bytes and only ${formatCount(available)} are present, so the file ends ${formatCount(bodyLength - available)} bytes early. That is the signature of an interrupted write — a crash, a disk that filled, or a cloud client that synchronised half a file. The missing bytes cannot be reconstructed from this file: an authenticated region decrypts whole or not at all.`
    );
    return finish();
  }
  reached = 'body-bytes';

  // ── The attachment chunks ──────────────────────────────────────────────────

  chunkCountOffset = cursor.offset;
  const chunkCount = cursor.uint32();
  if (chunkCount === null) {
    issues.push(issueFor('chunk-count-truncated', null));
    halt(
      'chunk-count',
      chunkCountOffset,
      LENGTH_FIELD_BYTES,
      cursor.remaining,
      `The body is complete and the file ends before the attachment count, ${formatCount(bytes.length)} bytes in. The records are very likely intact; any attachments are not in this file.`
    );
    return finish();
  }
  declaredChunkCount = chunkCount;
  reached = 'chunk-count';

  if (chunkCount * CHUNK_MINIMUM_BYTES > cursor.remaining) {
    issues.push(
      issueFor(
        'chunk-framing-broken',
        `declares ${formatCount(chunkCount)} attachments, ${formatCount(cursor.remaining)} bytes remain`
      )
    );
    halt(
      'chunk-count',
      chunkCountOffset,
      chunkCount * CHUNK_MINIMUM_BYTES,
      cursor.remaining,
      `The file declares ${formatCount(chunkCount)} attachments, which need at least ${formatCount(chunkCount * CHUNK_MINIMUM_BYTES)} bytes, and only ${formatCount(cursor.remaining)} remain. Either the count is corrupt or the tail of the file is gone.`
    );
    return finish();
  }

  for (let index = 0; index < chunkCount; index += 1) {
    const idOffset = cursor.offset;
    const idBytes = cursor.take(CHUNK_ID_BYTES);
    if (idBytes === null) {
      chunks.push({
        index,
        id: null,
        idOffset,
        declaredLength: null,
        present: false,
        availableBytes: cursor.remaining,
      });
      issues.push(issueFor('chunk-framing-broken', `attachment ${index} has no id`));
      halt(
        'chunk-framing',
        idOffset,
        CHUNK_ID_BYTES,
        cursor.remaining,
        `The file ends inside attachment ${formatCount(index)}'s id, ${formatCount(bytes.length)} bytes in. The records and the earlier attachments are unaffected.`
      );
      return finish();
    }
    const id = Buffer.from(idBytes).toString('hex');

    const declaredLength = cursor.uint32();
    if (declaredLength === null) {
      chunks.push({
        index,
        id,
        idOffset,
        declaredLength: null,
        present: false,
        availableBytes: cursor.remaining,
      });
      issues.push(issueFor('chunk-framing-broken', `attachment ${id} has no length field`));
      halt(
        'chunk-framing',
        cursor.offset,
        LENGTH_FIELD_BYTES,
        cursor.remaining,
        `The file ends inside attachment ${id}'s length field. The records and the earlier attachments are unaffected.`
      );
      return finish();
    }

    if (declaredLength > MAX_CHUNK_BYTES || declaredLength < SEALED_MINIMUM_BYTES) {
      chunks.push({
        index,
        id,
        idOffset,
        declaredLength,
        present: false,
        availableBytes: cursor.remaining,
      });
      issues.push(
        issueFor(
          'chunk-framing-broken',
          `attachment ${id} declares ${formatCount(declaredLength)} bytes`
        )
      );
      halt(
        'chunk-framing',
        cursor.offset,
        declaredLength,
        cursor.remaining,
        `Attachment ${id} declares ${formatCount(declaredLength)} bytes, which is outside the ${formatCount(SEALED_MINIMUM_BYTES)}–${formatCount(MAX_CHUNK_BYTES)} range a chunk can be. Its length field is corrupt, and nothing after it can be located.`
      );
      return finish();
    }

    const available = cursor.remaining;
    const blob = cursor.take(declaredLength);
    if (blob === null) {
      chunks.push({
        index,
        id,
        idOffset,
        declaredLength,
        present: false,
        availableBytes: available,
      });
      issues.push(
        issueFor(
          'chunk-framing-broken',
          `attachment ${id} declares ${formatCount(declaredLength)} bytes, ${formatCount(available)} available`
        )
      );
      halt(
        'chunk-framing',
        cursor.offset,
        declaredLength,
        available,
        `Attachment ${id} declares ${formatCount(declaredLength)} bytes and only ${formatCount(available)} remain, so the file ends ${formatCount(declaredLength - available)} bytes early. The records and the ${formatCount(index)} attachment(s) before it are unaffected — the tail was truncated.`
      );
      return finish();
    }

    chunks.push({ index, id, idOffset, declaredLength, present: true, availableBytes: available });
  }
  reached = 'chunk-framing';

  // ── The tail ───────────────────────────────────────────────────────────────

  if (chunkCount !== parsed.attachmentCount) {
    // The reader refuses on this, and it is worth its own finding here: the records can be
    // perfectly readable while an attachment has quietly vanished, which is the one kind of
    // damage a user would otherwise never notice.
    issues.push(
      issueFor(
        'chunk-count-disagreement',
        `header records ${formatCount(parsed.attachmentCount)}, file contains ${formatCount(chunkCount)}`
      )
    );
  }

  if (cursor.remaining > 0) {
    issues.push(
      issueFor('trailing-bytes', `${formatCount(cursor.remaining)} bytes after the last chunk`)
    );
  }
  reached = 'complete';

  return finish();
}

function verdictFor(stop: InspectionStop | null, issueCount: number): string {
  if (stop !== null) return stop.meaning;
  if (issueCount > 0) {
    return 'The container is structurally complete — every length, offset and chunk frame is present and self-consistent — but the findings below need attention. Whether the contents decrypt can only be established with the master password.';
  }
  return 'The container is structurally complete: signature, version, header, body framing and every attachment chunk are present and self-consistent. That is everything that can be known without the master password, and it is not a promise that the contents will decrypt.';
}
