// SPDX-License-Identifier: GPL-3.0-or-later
import {
  UNKNOWN_MIME,
  type AttachmentMimeCheck,
  type AttachmentPreviewKind,
} from '@shared/model/attachment.js';

/**
 * Format detection from the leading bytes, and the claimed-type check built on it.
 *
 * ## The claim is not evidence
 *
 * The MIME type arrives from the renderer, which got it from a drag-and-drop event or an
 * OS file dialog, which got it from the file's *extension*. Nothing in that chain looked
 * at the file. So `evil.pdf` claiming `application/pdf` proves nothing at all, and the
 * claim is exactly the input an attacker controls when they hand someone a file to attach.
 *
 * What the claim decides, if believed, is **which viewer renders the bytes** — and pointing
 * a PDF renderer at a crafted file, or an image tag at an SVG full of script, is the entire
 * attack. So the stored type is the *sniffed* one whenever we recognise the format, and the
 * claim survives only as a report the UI can show.
 *
 * ## What this does NOT do
 *
 * It compares a handful of leading bytes against a fixed table. It does not parse, decode,
 * decompress, execute, or validate the file in any way, and it must never start: a format
 * parser is a memory-safety liability, and the whole point of an offline vault is that
 * putting a file in it does not run anything. A file whose first bytes we do not recognise
 * gets no preview — which is the safe answer, not a limitation to fix — and if it claimed a
 * format that has a signature, it is stored as `application/octet-stream` rather than as the
 * claim. The one thing a claim alone can still buy is `SIGNATURE_FREE_PREVIEWS`.
 *
 * ## Why these formats
 *
 * The five the product actually previews (PNG, JPEG, GIF, PDF, plus the ZIP family, which
 * is every Office document), plus WebP, BMP and TIFF because they are what a phone or a
 * scanner produces and a user photographing a document will hit them without knowing.
 * There is deliberately no entry for SVG or HTML: both are text with no reliable signature
 * and both are script-bearing, so they fall through to `other` and never get a preview.
 */

/** One `bytes at offset` test. Every part of a pattern must match for the pattern to match. */
interface SignaturePart {
  readonly offset: number;
  readonly bytes: readonly number[];
}

interface FormatEntry {
  readonly mime: string;
  readonly kind: AttachmentPreviewKind;
  /**
   * Other MIME strings a caller may legitimately claim for this format. A browser saying
   * `image/jpg` or an OS saying `application/x-zip-compressed` is not lying, it is using a
   * different spelling, and reporting that as a mismatch would cry wolf.
   */
  readonly aliases: readonly string[];
  /** Alternatives — any one matching identifies the format. */
  readonly patterns: readonly (readonly SignaturePart[])[];
}

/** ASCII helper, so the tables below read as the strings they are in a hex editor. */
function ascii(text: string): number[] {
  return Array.from(Buffer.from(text, 'ascii'));
}

/**
 * **The one format registry.** Every question about "what is this file" is answered from
 * here — detection, aliases, and the preview kind — so there is no second list to drift.
 */
const FORMATS: readonly FormatEntry[] = [
  {
    mime: 'image/png',
    kind: 'image',
    aliases: [],
    patterns: [[{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }]],
  },
  {
    mime: 'image/jpeg',
    kind: 'image',
    // The fourth byte varies by marker (JFIF, Exif, raw), so only three bytes are fixed.
    aliases: ['image/jpg', 'image/pjpeg'],
    patterns: [[{ offset: 0, bytes: [0xff, 0xd8, 0xff] }]],
  },
  {
    mime: 'image/gif',
    kind: 'image',
    aliases: [],
    patterns: [[{ offset: 0, bytes: ascii('GIF87a') }], [{ offset: 0, bytes: ascii('GIF89a') }]],
  },
  {
    mime: 'image/webp',
    kind: 'image',
    aliases: [],
    // RIFF container: the four-byte size sits between the two markers, so both are checked.
    patterns: [
      [
        { offset: 0, bytes: ascii('RIFF') },
        { offset: 8, bytes: ascii('WEBP') },
      ],
    ],
  },
  {
    mime: 'image/bmp',
    kind: 'image',
    aliases: ['image/x-ms-bmp'],
    patterns: [[{ offset: 0, bytes: ascii('BM') }]],
  },
  {
    mime: 'image/tiff',
    kind: 'image',
    aliases: ['image/tif'],
    // Little-endian ("II") and big-endian ("MM") byte orders are both legal TIFF.
    patterns: [
      [{ offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] }],
      [{ offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] }],
    ],
  },
  {
    mime: 'application/pdf',
    kind: 'pdf',
    aliases: ['application/x-pdf'],
    patterns: [[{ offset: 0, bytes: ascii('%PDF-') }]],
  },
  {
    mime: 'application/zip',
    kind: 'archive',
    /**
     * Every one of these is a ZIP with a manifest inside. We do not open the archive to
     * tell them apart — that would mean decompressing attacker-supplied data to answer a
     * cosmetic question — so they are accepted as claims rather than detected.
     */
    aliases: [
      'application/x-zip-compressed',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.presentation',
      'application/epub+zip',
      'application/java-archive',
    ],
    patterns: [
      [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }],
      // An empty archive, and a spanned one. Both are valid ZIPs and both appear in the wild.
      [{ offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06] }],
      [{ offset: 0, bytes: [0x50, 0x4b, 0x07, 0x08] }],
    ],
  },
];

/**
 * The types that are previewable **and have no signature to check**, so a claim is the only
 * evidence there will ever be.
 *
 * This is the whole of what a claim may buy when the bytes matched nothing. Both entries are
 * rendered as *text*, which is inserted as text and executes nothing — so believing the
 * claim widens nothing an attacker can use. Everything script-bearing (`text/html`,
 * `image/svg+xml`) is deliberately absent here for the same reason it is absent from
 * `FORMATS`.
 *
 * One list, read by both the unknown branch of `checkMimeClaim` and `previewKindForMime`,
 * so the two can never disagree about what a signature-free type renders as.
 */
const SIGNATURE_FREE_PREVIEWS: ReadonlyMap<string, AttachmentPreviewKind> = new Map([
  ['text/plain', 'text'],
  ['text/csv', 'text'],
]);

/**
 * How many leading bytes detection needs. The furthest test is WebP's marker at offset 8.
 * Nothing reads past this, so a caller may sniff from a header slice rather than a whole
 * file — which is what makes it safe to sniff before deciding whether to load a 20 MB file.
 */
export const SNIFF_BYTES = 16;

export interface SniffedFormat {
  readonly mime: string;
  readonly kind: AttachmentPreviewKind;
}

/** The recognised format, or `null`. Reads at most `SNIFF_BYTES` bytes and never parses. */
export function sniffFormat(bytes: Uint8Array): SniffedFormat | null {
  for (const entry of FORMATS) {
    for (const pattern of entry.patterns) {
      if (matchesPattern(bytes, pattern)) return { mime: entry.mime, kind: entry.kind };
    }
  }
  return null;
}

function matchesPattern(bytes: Uint8Array, pattern: readonly SignaturePart[]): boolean {
  return pattern.every((part) =>
    part.bytes.every((expected, index) => bytes[part.offset + index] === expected)
  );
}

/**
 * RFC 6838 restricted-name characters, one type and one subtype.
 *
 * Anything else is discarded rather than escaped. A claimed type with a newline, a quote or
 * a semicolon in it is either broken or an attempt to smuggle something into whatever
 * header or attribute the value eventually lands in, and neither deserves a best effort.
 */
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * Normalises a claimed type: lower-cased, trimmed, parameters (`; charset=…`) dropped.
 *
 * Parameters are dropped rather than kept because nothing downstream uses them and they are
 * the free-text half of the value — `text/plain; charset="<script>"` is a claim, not a
 * character set. An unusable claim becomes `application/octet-stream`, which is exactly
 * what "I do not know" should look like.
 */
export function normaliseMimeClaim(claimed: string): string {
  const withoutParameters = claimed.split(';')[0] ?? '';
  const candidate = withoutParameters.trim().toLowerCase();
  return MIME_PATTERN.test(candidate) ? candidate : UNKNOWN_MIME;
}

/**
 * The registry entry a claimed type names, counting alternative spellings. `null` if none.
 *
 * The one place the "is `image/jpg` the same claim as `image/jpeg`" question is answered, so
 * confirming a claim and detecting a lie cannot come to different conclusions about it.
 */
function formatForMime(mime: string): FormatEntry | null {
  for (const entry of FORMATS) {
    if (entry.mime === mime || entry.aliases.includes(mime)) return entry;
  }
  return null;
}

/**
 * Compares what the caller claimed against what the bytes are.
 *
 * The result's `stored` field is what goes into `AttachmentMeta.mime`, and it is the
 * detected type whenever there is one — a mismatch is recorded and shown, never obeyed.
 */
export function checkMimeClaim(claimed: string, bytes: Uint8Array): AttachmentMimeCheck {
  const normalised = normaliseMimeClaim(claimed);
  const sniffed = sniffFormat(bytes);

  if (sniffed === null) {
    /*
     * Nothing recognised. **N8**: the comment that used to sit here said a parser-selecting
     * claim could not reach this branch, and it was wrong — `mismatch` needs the bytes to
     * match some *other* known format, so bytes matching nothing land here carrying whatever
     * the caller claimed. Routing that claim back through the registry handed a file that
     * failed every signature test to the PDF or image viewer on the strength of its name.
     *
     * So the registry no longer decides the preview kind here; it is consulted only to spot
     * the lie. A claim naming a format that *has* a signature, when none matched, is a lie
     * rather than an unknown — it is dropped
     * for `UNKNOWN_MIME`, which also stops a later reader of `AttachmentMeta.mime` from
     * resurrecting the parser through `previewKindForMime`. (A real PDF behind a 100-byte
     * prefix lands here too: detection reads `SNIFF_BYTES` where pdf.js scans 1024. Storing
     * "unrecognised" for it is the correct, conservative answer.)
     *
     * Everything else keeps its claim, and only `SIGNATURE_FREE_PREVIEWS` — text — buys a
     * preview from a claim alone.
     */
    const lying = formatForMime(normalised) !== null;
    const stored = lying ? UNKNOWN_MIME : normalised;
    return {
      claimed: normalised,
      detected: null,
      status: 'unknown',
      stored,
      kind: SIGNATURE_FREE_PREVIEWS.get(stored) ?? 'other',
    };
  }

  // `sniffed.mime` came out of the registry, so this lookup always finds an entry; comparing
  // the two lookups by identity is what makes an alias of the detected format a confirmation
  // and an alias of any *other* format a mismatch.
  const entry = formatForMime(sniffed.mime);
  const confirmed = entry !== null && formatForMime(normalised) === entry;

  return {
    claimed: normalised,
    detected: sniffed.mime,
    status: confirmed ? 'confirmed' : 'mismatch',
    stored: sniffed.mime,
    kind: sniffed.kind,
  };
}

/**
 * The preview kind for a type already stored in an `AttachmentMeta`.
 *
 * Reads the same registry as detection, so a stored `image/png` and a freshly sniffed one
 * can never disagree about what to render. Anything not in the table — including a claim
 * that was believed because nothing matched — is `other`, and `other` gets no preview.
 */
export function previewKindForMime(mime: string): AttachmentPreviewKind {
  const normalised = normaliseMimeClaim(mime);
  for (const entry of FORMATS) {
    if (entry.mime === normalised) return entry.kind;
  }
  // Canonical spellings only — deliberately not `formatForMime`. A stored type is either the
  // canonical one detection produced or a claim no signature-bearing format owns (see N8 in
  // `checkMimeClaim`), so an alias can never be stored, and refusing to widen on one keeps
  // this the narrower of the two lookups.
  return SIGNATURE_FREE_PREVIEWS.get(normalised) ?? 'other';
}
