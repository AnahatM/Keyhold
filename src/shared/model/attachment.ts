// SPDX-License-Identifier: GPL-3.0-or-later
import type { AttachmentMeta } from './credential.js';
import { MAX_CHUNK_BYTES } from '../format/types.js';

/**
 * Attachment limits, settings, and the shapes that cross the bridge.
 *
 * `AttachmentMeta` itself lives in `credential.js`, beside the record it hangs off. This
 * file holds everything *about* attachments that both processes need: the caps (the
 * renderer has to say "25 MB maximum" before it reads a file, not after), the settings
 * that make those caps the user's choice, and the report shapes the audit produces.
 *
 * **Nothing here touches bytes.** Sniffing, hashing, sanitising and reference counting all
 * live in `src/main/attachments/`, where the renderer cannot reach them.
 *
 * ## Why an attachment is metadata here and bytes over there
 *
 * A `Credential` carries `AttachmentMeta[]` — names, sizes, digests. The bytes live in
 * their own encrypted chunks in the KEEP container, keyed by `meta.id`. That split is the
 * whole reason a vault with a 20 MB passport scan still unlocks quickly, and it is also
 * why the two halves can disagree: a merge that dropped a record leaves its chunks behind,
 * and a partial restore can leave a meta pointing at a chunk that is not there. Both are
 * real, both are detectable, and `AttachmentAudit` is how they are reported.
 */

// ── Preview classification ───────────────────────────────────────────────────

/**
 * What a viewer could plausibly do with this file.
 *
 * Derived from **sniffed** bytes, never from the claimed MIME type or the filename — the
 * kind decides which preview component renders the file, and letting an attacker-supplied
 * string pick the renderer is how a "PDF" ends up in an image tag or worse.
 *
 * `archive` is its own kind rather than `other` because every Office document is a ZIP,
 * so this is the single commonest attachment that has no safe inline preview at all.
 */
export const ATTACHMENT_PREVIEW_KINDS = ['image', 'pdf', 'text', 'archive', 'other'] as const;
export type AttachmentPreviewKind = (typeof ATTACHMENT_PREVIEW_KINDS)[number];

/** What a file with no recognised signature is stored as. */
export const UNKNOWN_MIME = 'application/octet-stream';

// ── Limits ───────────────────────────────────────────────────────────────────

/**
 * The caps, and the reasoning behind the numbers.
 *
 * **The real constraint is that a vault is decrypted whole into memory.** `readContainer`
 * decrypts every chunk on unlock, and `writeContainer` concatenates the entire file into
 * one buffer on save — so at peak the process is holding roughly the plaintext, the
 * ciphertext, and the assembled file at once. Attachment bytes are therefore not "disk
 * space", they are resident memory in the main process, about three times over.
 *
 * - **25 MiB per file.** A scanned passport is ~2 MB, a photographed document ~5 MB, a
 *   recovery-code PDF a few hundred KB. 25 MiB comfortably covers all of those and stops
 *   someone dropping a video in. It is the roadmap's stated default and it is a *setting*,
 *   because the person who wants a 60 MB CAD file in their vault is not wrong, they are
 *   just accepting a slower unlock (decision D10).
 * - **5 MiB warn threshold.** Not a refusal — a prompt. Above this the unlock cost becomes
 *   noticeable, and the user deserves to be told before they commit rather than after.
 * - **128 MiB per vault.** Three times that is ~384 MB resident at save, which a desktop
 *   app can survive; 256 MiB would put peak past 750 MB and make unlock visibly hostile.
 *   Note this is the total of **distinct** chunks: two records sharing one deduped file
 *   count it once, because the file is stored once.
 * - **64 attachments per record.** Metadata lives in the encrypted body, which is parsed
 *   in full on every unlock. A record with ten thousand metas is a body-size problem even
 *   if every chunk is tiny.
 *
 * Every one of these is checked against the container's own ceiling in
 * `resolveAttachmentLimits`, so a setting can never be raised past what the format allows.
 */
export interface AttachmentSettings {
  readonly maxAttachmentBytes: number;
  readonly maxVaultAttachmentBytes: number;
  /** Above this, the UI asks before attaching. Never a refusal. */
  readonly warnAboveBytes: number;
  readonly maxAttachmentsPerRecord: number;
}

export const DEFAULT_ATTACHMENT_SETTINGS: AttachmentSettings = {
  maxAttachmentBytes: 26_214_400, // 25 MiB
  maxVaultAttachmentBytes: 134_217_728, // 128 MiB
  warnAboveBytes: 5_242_880, // 5 MiB
  maxAttachmentsPerRecord: 64,
};

/**
 * The hard ceilings a setting may not exceed.
 *
 * The container refuses to *read* a chunk above `MAX_CHUNK_BYTES`, so allowing a setting
 * above it would let someone write a vault their own app cannot reopen — data loss dressed
 * up as configurability.
 */
export const ATTACHMENT_CEILINGS = {
  maxAttachmentBytes: MAX_CHUNK_BYTES,
  maxVaultAttachmentBytes: MAX_CHUNK_BYTES,
  maxAttachmentsPerRecord: 4096,
} as const;

/**
 * Filesystem name limits.
 *
 * 255 is the shared floor: NTFS counts UTF-16 characters, ext4 and APFS count UTF-8 bytes.
 * Both are enforced, so a name of 200 CJK characters — 600 bytes — is still shortened.
 */
export const MAX_ATTACHMENT_NAME_LENGTH = 255;
export const MAX_ATTACHMENT_NAME_BYTES = 255;
/** What a name that sanitises down to nothing becomes. Never empty, never a path. */
export const FALLBACK_ATTACHMENT_NAME = 'attachment';

// ── MIME verification ────────────────────────────────────────────────────────

/**
 * What the leading bytes said, relative to what the caller claimed.
 *
 * A mismatch is **reported, not refused**. Refusing would lose a file the user chose to
 * keep, and the claim is usually wrong for innocent reasons — a browser guessing from an
 * extension, an OS that has never heard of the format. What we do instead is store the
 * *detected* type, so nothing downstream renders the file as something it is not.
 */
export type AttachmentMimeStatus =
  /** The bytes match the claim. */
  | 'confirmed'
  /** No signature we know. The claim is kept, after sanitising, because we have nothing better. */
  | 'unknown'
  /** The bytes are a format we recognise, and it is not the one that was claimed. */
  | 'mismatch';

export interface AttachmentMimeCheck {
  /** The caller's claim, lower-cased and stripped of parameters. Never trusted. */
  readonly claimed: string;
  /** What the leading bytes actually are, or `null` when nothing matched. */
  readonly detected: string | null;
  readonly status: AttachmentMimeStatus;
  /** What was written to `AttachmentMeta.mime`: the detected type when there is one. */
  readonly stored: string;
  readonly kind: AttachmentPreviewKind;
}

// ── Filename safety ──────────────────────────────────────────────────────────

/**
 * The result of cleaning a filename that arrived from outside.
 *
 * `disguised` is the `invoice.pdf.exe` case specifically: a runnable extension hiding
 * behind a document one. It is a flag rather than a refusal because the name is not what
 * makes a file run — opening it is — and Keyhold never opens an attachment. What the flag
 * buys is an honest warning at the one moment it matters, the "save to disk" dialog.
 */
export interface AttachmentNameCheck {
  readonly sanitised: string;
  /** True when sanitising changed anything, so the UI can say the name was altered. */
  readonly changed: boolean;
  readonly executable: boolean;
  readonly disguised: boolean;
}

/**
 * The kinds a preview will render, and the reason it is not simply "all of them".
 *
 * A preview hands the file's bytes to the renderer, so each entry here is a deliberate
 * widening of what the renderer holds. Three earn it, because for each the alternative is a
 * user saving a copy to disk purely to look at it — which puts a decrypted file on their
 * filesystem, permanently, to answer a question that took two seconds.
 *
 * Everything else is refused, and the refusals matter more than the allowances:
 *
 *  - **archives** would need unpacking to show anything, and unpacking untrusted input in
 *    the renderer is a whole attack surface bought for a directory listing;
 *  - **executables** have nothing to show, and rendering one implies the app understands it;
 *  - **unrecognised types** are unrecognised — a preview would be guessing, and guessing at
 *    the format of untrusted bytes is how a viewer becomes an exploit.
 *
 * Keyed off the **detected** kind rather than the claimed one, because the claim is the
 * attacker's to write. `AttachmentMimeCheck.kind` is already the sniffed answer.
 *
 * A `satisfies readonly AttachmentPreviewKind[]` subset, not a parallel list: renaming a
 * kind in `ATTACHMENT_PREVIEW_KINDS` is then a compile error here rather than a preview that
 * silently stops matching and falls through to "cannot show this".
 */
export const PREVIEWABLE_ATTACHMENT_KINDS = [
  'image',
  'pdf',
  'text',
] as const satisfies readonly AttachmentPreviewKind[];

export type PreviewableAttachmentKind = (typeof PREVIEWABLE_ATTACHMENT_KINDS)[number];

export function isPreviewableKind(kind: string): kind is PreviewableAttachmentKind {
  return (PREVIEWABLE_ATTACHMENT_KINDS as readonly string[]).includes(kind);
}

/**
 * One attachment's bytes, on their way to a preview.
 *
 * `bytes` rather than a data URL or a base64 string, deliberately. Base64 inflates a file by
 * a third and would be built, copied across the bridge and parsed again — for a 20 MB scan
 * that is three copies of somebody's passport in memory instead of one. A `Uint8Array`
 * survives structured clone as a transferable and the renderer turns it into a blob URL it
 * revokes the moment the viewer closes.
 *
 * The name travels because the viewer titles itself with it. Nothing else does: no path, no
 * digest, no record fields.
 */
export interface AttachmentPreview {
  readonly name: string;
  /** The **detected** type, never the claimed one. */
  readonly mime: string;
  readonly kind: PreviewableAttachmentKind;
  readonly bytes: Uint8Array;
}

// ── Audit ────────────────────────────────────────────────────────────────────

export const ATTACHMENT_ISSUE_CODES = [
  /** A record points at a chunk id the container does not contain. */
  'missing-chunk',
  /** A chunk nothing points at. Costs space; never silently deleted. */
  'unreferenced-chunk',
  /** The chunk exists, but its length is not what the metadata recorded. */
  'size-mismatch',
  /** Two metas on one record share a chunk id, so reveal-by-id is ambiguous. */
  'duplicate-id',
] as const;
export type AttachmentIssueCode = (typeof ATTACHMENT_ISSUE_CODES)[number];

/**
 * One finding. **Carries ids and numbers, never a filename and never file content** — this
 * crosses to the renderer and ends up in logs and screenshots.
 */
export interface AttachmentIssue {
  readonly code: AttachmentIssueCode;
  readonly chunkId: string;
  /** `null` for an unreferenced chunk: by definition no record claims it. */
  readonly credentialId: string | null;
  readonly detail: string | null;
}

export interface AttachmentAudit {
  readonly issues: readonly AttachmentIssue[];
  /** Chunks present in the container. */
  readonly chunkCount: number;
  /** Distinct chunk ids at least one record points at. */
  readonly referencedCount: number;
  /** Total bytes of distinct referenced chunks, as recorded in the metadata. */
  readonly totalBytes: number;
  readonly recordsWithAttachments: number;
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Shared so the renderer can map a code to its own copy rather than re-parsing an English
 * message — and so a message may stay free of anything the user typed.
 */
export type AttachmentErrorCode =
  /** One file is over the per-attachment cap. */
  | 'ATTACHMENT_TOO_LARGE'
  /** Storing it would put the vault over its total. */
  | 'VAULT_ATTACHMENT_LIMIT'
  | 'TOO_MANY_ATTACHMENTS'
  /** Zero bytes. Nothing to store, and a zero-length chunk is indistinguishable from a bug. */
  | 'EMPTY_ATTACHMENT'
  /** Two metas on one record share a chunk id. Addressing by id would be ambiguous. */
  | 'DUPLICATE_ATTACHMENT_ID'
  | 'NO_SUCH_ATTACHMENT'
  | 'NO_SUCH_RECORD'
  /** A configured limit is above what the container format can read back. */
  | 'INVALID_ATTACHMENT_LIMIT'
  /** Chunk bytes did not hash to the digest the metadata recorded. */
  | 'ATTACHMENT_INTEGRITY';

/**
 * What attaching a file reports back to the renderer.
 *
 * `AttachmentMeta` is already safe-projection material — name, size, mime, digest — so it
 * crosses as it is. The bytes never do. The three checks alongside it are the honest half: a
 * MIME claim that disagreed with the file, a filename that had to be sanitised, a size past
 * the warning threshold. Each is a thing to tell the user, not a reason to refuse.
 *
 * Declared here rather than beside `VaultService`, because `@shared` may never import from
 * `src/main` — the renderer compiles this file, and pulling main-process code in behind a
 * type would drag the whole module graph with it.
 */
export interface AttachmentAddView {
  readonly meta: AttachmentMeta;
  readonly deduped: boolean;
  readonly mime: AttachmentMimeCheck;
  readonly name: AttachmentNameCheck;
  readonly warnLarge: boolean;
}
