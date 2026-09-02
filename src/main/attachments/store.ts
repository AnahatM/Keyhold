// SPDX-License-Identifier: GPL-3.0-or-later
import type { AttachmentChunk } from '@shared/format/types.js';
import type {
  AttachmentMimeCheck,
  AttachmentNameCheck,
  AttachmentSettings,
} from '@shared/model/attachment.js';
import type { AttachmentMeta, Credential } from '@shared/model/credential.js';
import type { VaultDocument } from '@shared/model/vault-document.js';
import { SecretBytes } from '../crypto/secret.js';
import { replaceCredential } from '../vault/credential-ops.js';
import { sha256Hex } from './digest.js';
import {
  attachmentTooLarge,
  chunkIdCollision,
  duplicateAttachmentId,
  emptyAttachment,
  noSuchAttachment,
  noSuchRecord,
  tooManyAttachments,
  vaultAttachmentLimit,
} from './errors.js';
import { checkAttachmentName } from './filename.js';
import { resolveAttachmentLimits } from './limits.js';
import {
  chunkReferenceCounts,
  collectAttachmentMetas,
  distinctAttachmentBytes,
} from './references.js';
import { checkMimeClaim } from './sniff.js';

/**
 * Attaching and detaching files, as **pure functions over a document**.
 *
 * Nothing here opens a file, shows a dialog, or talks to IPC. The caller reads the bytes
 * and hands them over; what comes back is the new record and the chunk to store. That is
 * what lets the interesting parts — the dedupe, the reference boundary, the limits — be
 * tested directly, without an unlocked vault or a temp directory.
 *
 * ## Content-addressed dedupe, with a random id
 *
 * Two records attaching the same file share one chunk. The match is on **SHA-256 plus
 * size**, and the second attachment reuses the first's chunk id rather than storing the
 * bytes again.
 *
 * The obvious implementation is to make the chunk id *be* the digest — content addressing
 * in the literal sense, dedupe for free, no scan required. **That would be a serious
 * information leak and it is not what happens here.** Chunk ids are written to the file in
 * plaintext: they sit in the clear before each encrypted chunk, because the reader needs
 * them as AAD before it has decrypted anything. A content-derived id would therefore
 * publish a fingerprint of every attachment to anyone holding the locked file — turning
 * "is this person storing *this specific document*?" into a lookup, against an encrypted
 * vault, without the password. So the id stays random (`randomChunkId`), the digest lives
 * inside the encrypted body where it belongs, and dedupe costs one pass over metadata that
 * is already in memory.
 *
 * ## Within one record, a chunk id appears at most once
 *
 * `AttachmentMeta.id` **is** the chunk id, so two attachments on one record holding
 * identical bytes would carry the same id — and reveal, download and remove all address an
 * attachment *by that id*. A duplicate is therefore not a cosmetic problem, it is the same
 * class of bug as two custom fields sharing an id in `credential-ops.ts`: the operation
 * silently acts on the wrong one. So attaching bytes a record already holds returns the
 * existing attachment with `deduped: true` rather than adding a second entry, and
 * `assertAttachmentIdsUnique` refuses anything that got past that.
 *
 * ## Ownership of the plaintext bytes
 *
 * **`addAttachment` takes ownership of `input.bytes`.** An attachment can be a photograph
 * of a passport, and the caller holding a live second reference to those bytes after the
 * call is exactly how one ends up somewhere it should not be. So:
 *
 *   - on the dedupe path the bytes are destroyed immediately — the vault already has them,
 *     and a second plaintext copy is pure risk for no benefit;
 *   - on the store path they move into `result.chunk.data` and are the caller's to release,
 *     via `toContainerChunk` (which consumes it) or `releasePendingChunk`;
 *   - if anything throws, they are destroyed before the error leaves this function. The
 *     error path is where things go wrong, which is precisely when a leak matters.
 *
 * This is a real improvement, not a guarantee — `secret.ts` is explicit that V8 copies
 * buffers and Node offers no `mlock`.
 */

// ── Adding ───────────────────────────────────────────────────────────────────

export interface AddAttachmentInput {
  /** As it came from the OS. Sanitised here; never used to build a path. */
  readonly name: string;
  /** The caller's claimed type. Verified against the bytes, never trusted. */
  readonly mime: string;
  /** The file contents. **Ownership transfers to this call** — see the module note. */
  readonly bytes: SecretBytes;
  readonly now: number;
  /** A fresh random chunk id. Used only if these bytes are new to the vault. */
  readonly newId: string;
  /**
   * Every attachment meta in the vault, this record's included.
   *
   * Required rather than optional, because it is what both the dedupe search and the
   * per-vault total are computed from. A caller who omitted it would get a correct-looking
   * result with no dedupe and a total of zero — a limit that never fires is worse than no
   * limit, because it looks like one. `addAttachmentToDocument` fills it in for you.
   */
  readonly existing: readonly AttachmentMeta[];
  readonly settings?: Partial<AttachmentSettings> | undefined;
}

/** A chunk that is ready to be written, still holding its plaintext under `SecretBytes`. */
export interface PendingAttachmentChunk {
  readonly id: string;
  readonly data: SecretBytes;
}

export interface AddAttachmentResult {
  readonly credential: Credential;
  readonly meta: AttachmentMeta;
  /** The chunk to store, or `null` when an identical one is already in the vault. */
  readonly chunk: PendingAttachmentChunk | null;
  readonly deduped: boolean;
  readonly mime: AttachmentMimeCheck;
  readonly name: AttachmentNameCheck;
  /** Over the warning threshold. A prompt for the UI, never a refusal. */
  readonly warnLarge: boolean;
}

export function addAttachment(record: Credential, input: AddAttachmentInput): AddAttachmentResult {
  try {
    return attach(record, input);
  } catch (error) {
    // Ownership was taken at the call boundary, so the bytes are ours to clean up even when
    // — especially when — the operation failed.
    input.bytes.destroy();
    throw error;
  }
}

function attach(record: Credential, input: AddAttachmentInput): AddAttachmentResult {
  const limits = resolveAttachmentLimits(input.settings);
  const size = input.bytes.length;

  // Size first, before hashing: rejecting a 2 GB file should not cost a pass over 2 GB.
  if (size === 0) throw emptyAttachment();
  if (size > limits.maxAttachmentBytes) throw attachmentTooLarge(size, limits.maxAttachmentBytes);

  const digest = input.bytes.use(sha256Hex);
  const mime = input.bytes.use((bytes) => checkMimeClaim(input.mime, bytes));
  const name = checkAttachmentName(input.name);
  const warnLarge = size > limits.warnAboveBytes;

  // Already on this record. Return what is there rather than adding a colliding id — and
  // keep the existing attachment's name, because renaming a file the user already stored is
  // not what "attach this again" asked for.
  const onRecord = record.attachments.find((meta) => meta.sha256 === digest && meta.size === size);
  if (onRecord !== undefined) {
    input.bytes.destroy();
    return {
      credential: record,
      meta: onRecord,
      chunk: null,
      deduped: true,
      mime,
      name,
      warnLarge,
    };
  }

  if (record.attachments.length >= limits.maxAttachmentsPerRecord) {
    throw tooManyAttachments(limits.maxAttachmentsPerRecord);
  }

  // Elsewhere in the vault. Reuse the chunk; this record gets its own metadata, so the two
  // attachments may legitimately carry different names.
  const inVault = input.existing.find((meta) => meta.sha256 === digest && meta.size === size);

  let chunk: PendingAttachmentChunk | null = null;
  let chunkId: string;

  if (inVault === undefined) {
    // A genuinely new chunk, so this is the only path where the vault grows.
    const wouldBe = distinctAttachmentBytes(input.existing) + size;
    if (wouldBe > limits.maxVaultAttachmentBytes) {
      throw vaultAttachmentLimit(wouldBe, limits.maxVaultAttachmentBytes, size);
    }
    if (input.existing.some((meta) => meta.id === input.newId)) throw chunkIdCollision(input.newId);

    chunkId = input.newId;
    chunk = { id: chunkId, data: input.bytes };
  } else {
    chunkId = inVault.id;
    input.bytes.destroy();
  }

  const meta: AttachmentMeta = {
    id: chunkId,
    name: name.sanitised,
    // The detected type, not the claimed one. What is stored here decides which viewer
    // renders the file, and that decision must not be the uploader's to make.
    mime: mime.stored,
    size,
    sha256: digest,
    addedAt: input.now,
  };

  const credential: Credential = { ...record, attachments: [...record.attachments, meta] };
  assertAttachmentIdsUnique(credential);

  return { credential, meta, chunk, deduped: inVault !== undefined, mime, name, warnLarge };
}

/** `AddAttachmentInput` with the vault-wide fields this module can work out for itself. */
export type DocumentAttachInput = Omit<AddAttachmentInput, 'existing'>;

export interface DocumentAttachResult extends Omit<AddAttachmentResult, 'credential'> {
  readonly document: VaultDocument;
}

/**
 * The document-level version, and the one callers should reach for.
 *
 * It exists so nobody has to remember to assemble `existing` — the footgun described on
 * that field — and so the dedupe search really does see the whole vault rather than
 * whatever subset the call site happened to have to hand.
 */
export function addAttachmentToDocument(
  document: VaultDocument,
  credentialId: string,
  input: DocumentAttachInput
): DocumentAttachResult {
  const record = document.records.find((candidate) => candidate.id === credentialId);
  if (record === undefined) {
    input.bytes.destroy();
    throw noSuchRecord(credentialId);
  }

  const result = addAttachment(record, { ...input, existing: collectAttachmentMetas(document) });
  const { credential, ...rest } = result;
  return { ...rest, document: replaceCredential(document, credential) };
}

// ── Removing ─────────────────────────────────────────────────────────────────

export interface RemoveAttachmentResult {
  readonly document: VaultDocument;
  /** The attachment that was removed. */
  readonly meta: AttachmentMeta;
  /**
   * Whether the chunk may now be dropped from the container.
   *
   * `false` means another record still points at it — deleting it anyway would take a file
   * out from under an attachment that still displays it.
   */
  readonly chunkOrphaned: boolean;
}

/**
 * Detaches one attachment and reports whether its chunk is now unreferenced.
 *
 * The reference count is taken **before** the removal and compared against one, rather than
 * recomputed afterwards, because the two differ only in how easy they are to get wrong: the
 * question is "was I the last referrer", and asking it in that form makes the boundary a
 * single comparison rather than an arithmetic identity to re-derive at each call site.
 */
export function removeAttachment(
  document: VaultDocument,
  credentialId: string,
  chunkId: string
): RemoveAttachmentResult {
  const record = document.records.find((candidate) => candidate.id === credentialId);
  if (record === undefined) throw noSuchRecord(credentialId);

  const meta = record.attachments.find((candidate) => candidate.id === chunkId);
  if (meta === undefined) throw noSuchAttachment(chunkId);

  const references = chunkReferenceCounts(document).get(chunkId) ?? 0;
  const credential: Credential = {
    ...record,
    attachments: record.attachments.filter((candidate) => candidate.id !== chunkId),
  };

  return {
    document: replaceCredential(document, credential),
    meta,
    chunkOrphaned: references <= 1,
  };
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Refuses a record whose attachments would be ambiguous to address.
 *
 * Called on every add. Belongs in `assertValidCredential` too, so a record arriving from an
 * import or a merge is held to the same rule — see the report note; that file is not this
 * module's to edit.
 */
export function assertAttachmentIdsUnique(record: Credential): void {
  const seen = new Set<string>();
  for (const meta of record.attachments) {
    if (seen.has(meta.id)) throw duplicateAttachmentId(meta.id);
    seen.add(meta.id);
  }
}

// ── Handing a chunk to the container ─────────────────────────────────────────

/**
 * Converts a pending chunk into the container's plain-bytes shape, **consuming it**.
 *
 * The copy is unavoidable: `AttachmentChunk.data` is a bare `Uint8Array` because the format
 * layer knows nothing about secrets, by design. What is avoidable is keeping the managed
 * copy alive afterwards, so it is destroyed here — from this point the plaintext exists
 * once, in the buffer the writer is about to encrypt, and dies with it.
 */
export function toContainerChunk(pending: PendingAttachmentChunk): AttachmentChunk {
  const data = pending.data.use((bytes) => Uint8Array.from(bytes));
  pending.data.destroy();
  return { id: pending.id, data };
}

/** Drops a pending chunk that will not be stored. Idempotent, so it is safe in a `finally`. */
export function releasePendingChunk(pending: PendingAttachmentChunk | null): void {
  pending?.data.destroy();
}

/** Wraps freshly-read file bytes for `addAttachment`, taking ownership of the buffer. */
export function adoptAttachmentBytes(bytes: Uint8Array): SecretBytes {
  return SecretBytes.adopt(bytes);
}
