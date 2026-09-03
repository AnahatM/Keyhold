// SPDX-License-Identifier: GPL-3.0-or-later
import { inflateRawSync } from 'node:zlib';
import { VaultError } from '../crypto/errors.js';
import { stripBom } from './csv.js';

/**
 * A minimal, **read-only** ZIP reader — enough to open a `.1pux`, and deliberately no more.
 *
 * ## Why this exists rather than a dependency
 *
 * A `.1pux` is a ZIP archive holding `export.data` and a `files/` directory. Reading one
 * needs exactly two things: the ability to find an entry, and the ability to inflate it.
 * `node:zlib` already ships `inflateRawSync`, which is the whole of DEFLATE, so the missing
 * piece is about two hundred lines of structure parsing. Adding a general-purpose ZIP library
 * to a password manager to obtain those two hundred lines means adding a package that also
 * writes archives, walks the filesystem, handles encryption and follows symlinks — a great
 * deal of attack surface, in the one process that holds the master key, to read one JSON file.
 *
 * ## What it deliberately does not do
 *
 * No writing. No ZIP64. No traditional or AES encryption. No CP437 filenames. No multi-disk
 * or spanned archives. No data-descriptor guessing — sizes are taken from the **central
 * directory**, which is the authoritative copy and is present whether or not the local header
 * bothered to fill its own in. Each of those is refused with a specific error rather than
 * half-implemented, because a ZIP reader that silently misreads a field is a ZIP reader that
 * hands the caller somebody else's bytes.
 *
 * ZIP64 in particular costs nothing to refuse: it only appears above 4 GiB, and
 * `MAX_IMPORT_FILE_BYTES` caps an import at 64 MiB long before that. Refusing it is a real
 * statement about correctness, not a functional limitation.
 *
 * ## The threat model — read this before changing anything below
 *
 * **Every byte here is attacker-controlled.** The user picked a file; nothing says the file
 * is what it claims to be, and "import a password export somebody sent me" is a plausible
 * social-engineering route into this process. So:
 *
 *  - **Every read is bounds-checked** through {@link requireRange}. There is no unchecked
 *    index in this file, and a truncated archive produces an error rather than a `NaN` length
 *    that becomes an enormous allocation two lines later.
 *  - **Every declared size is capped before it is believed.** `inflateRawSync`'s
 *    `maxOutputLength` is the same defence `format/container.ts` uses on the vault body, and
 *    for the same reason: a 40-byte DEFLATE stream can declare — and produce — gigabytes.
 *    The cap is enforced twice, once as a declared-size check and once by zlib itself, so a
 *    header that lies low is caught as well as one that lies high.
 *  - **Entry names are validated even though nothing is written to disk.** Zip-slip is
 *    usually an extraction bug, and this reader never extracts; but the names still reach
 *    lookup code and error paths, and a name is the one field an archive gets to choose
 *    freely. `..`, absolute paths, drive letters, backslashes, NULs and control characters
 *    are all refused. See {@link assertSafeEntryName} for what each one is guarding.
 *  - **No entry name appears in an error message.** Names inside a `.1pux` include the user's
 *    own attachment filenames, which are vault content; errors are logged, screenshotted and
 *    pasted into bug reports (hard rule 1). Entries are referred to by position instead.
 */

// ── Limits ───────────────────────────────────────────────────────────────────

export interface ZipLimits {
  /** Refused before the directory is walked, so a declared count cannot drive an allocation. */
  readonly maxEntries: number;
  /** The largest uncompressed size any single entry may produce. */
  readonly maxEntryBytes: number;
  /** The largest total across every read on one archive. The zip-bomb ceiling. */
  readonly maxTotalBytes: number;
}

/**
 * The defaults.
 *
 * `maxEntryBytes` matches `MAX_IMPORT_FILE_BYTES` in `import-service/source-store.ts` — an
 * entry cannot usefully be larger than the largest file the import pipeline will accept in
 * the first place. `maxTotalBytes` is twice that rather than equal to it, because a genuine
 * `.1pux` legitimately contains `export.data` *and* attachments and the sum of the parts is
 * the number that matters for a bomb.
 */
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
};

/** The longest entry name accepted. Real archives are far under this; a bomb is not. */
export const MAX_ZIP_ENTRY_NAME_LENGTH = 1024;

// ── On-disk constants ────────────────────────────────────────────────────────

const SIGNATURE_LOCAL_HEADER = 0x04034b50;
const SIGNATURE_CENTRAL_HEADER = 0x02014b50;
const SIGNATURE_EOCD = 0x06054b50;
const SIGNATURE_ZIP64_EOCD_LOCATOR = 0x07064b50;
const SIGNATURE_ZIP64_EOCD = 0x06064b50;

const LOCAL_HEADER_FIXED_BYTES = 30;
const CENTRAL_HEADER_FIXED_BYTES = 46;
const EOCD_FIXED_BYTES = 22;

/** The EOCD is followed by a comment of up to 64 KiB, so the backwards scan is bounded. */
const MAX_ZIP_COMMENT_BYTES = 0xffff;

/** The sentinel a ZIP64 archive writes into a 32-bit field it has outgrown. */
const ZIP64_MARKER_32 = 0xffffffff;
const ZIP64_MARKER_16 = 0xffff;

export const ZIP_METHOD_STORED = 0;
export const ZIP_METHOD_DEFLATED = 8;

/** General-purpose flag bit 0: the entry is encrypted. */
const FLAG_ENCRYPTED = 0x0001;
/** Bits 1, 2 and 6 also signal encryption variants (strong encryption, AES). */
const FLAG_STRONG_ENCRYPTION = 0x0040;

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * The one error shape this reader produces.
 *
 * A `VaultError` rather than a bare `Error` because the IPC layer scrubs anything it does not
 * recognise into "something went wrong", and "this file is not a ZIP archive" is a sentence a
 * user can act on. The detail never contains an entry name or any archive content — see the
 * threat-model note above.
 */
function damaged(detail: string): VaultError {
  return new VaultError('MALFORMED', `This archive could not be read: ${detail}.`);
}

function refusedSize(what: string, size: number, limit: number): VaultError {
  return new VaultError(
    'TOO_LARGE',
    `Refusing to read ${what}: it declares ${size} bytes, above the ${limit}-byte safety limit.`
  );
}

// ── Bounds-checked primitive reads ───────────────────────────────────────────

/**
 * The single place an out-of-bounds read is turned into an error.
 *
 * Every structured read below calls this first. `Uint8Array` returns `undefined` past its end
 * rather than throwing, and `undefined` coerced into arithmetic becomes `NaN` — which then
 * flows into a length, an offset and eventually an allocation. Checking up front is what makes
 * "a truncated archive is an error" true by construction rather than by inspection.
 */
function requireRange(bytes: Uint8Array, offset: number, length: number, what: string): void {
  if (!Number.isInteger(offset) || offset < 0) throw damaged(`${what} is at an impossible offset`);
  if (offset + length > bytes.length) throw damaged(`the file ends part-way through ${what}`);
}

function readU16(bytes: Uint8Array, offset: number, what: string): number {
  requireRange(bytes, offset, 2, what);
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

/**
 * A 32-bit little-endian read, as an unsigned JavaScript number.
 *
 * The top byte is multiplied rather than shifted: `<< 24` in JavaScript produces a *signed*
 * 32-bit result, so a size of 0xFFFFFFFF would arrive as -1 and compare below every cap.
 */
function readU32(bytes: Uint8Array, offset: number, what: string): number {
  requireRange(bytes, offset, 4, what);
  return (
    (bytes[offset] ?? 0) +
    (bytes[offset + 1] ?? 0) * 0x100 +
    (bytes[offset + 2] ?? 0) * 0x10000 +
    (bytes[offset + 3] ?? 0) * 0x1000000
  );
}

// ── CRC-32 ───────────────────────────────────────────────────────────────────

let crcTable: Uint32Array | null = null;

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

/**
 * The ZIP checksum — IEEE 802.3 CRC-32, the same one `gzip` and PNG use.
 *
 * Exported because the test's archive writer needs it too, and because a checksum with no
 * pinned test vector is a checksum nobody has verified. `zip-reader.test.ts` pins it against
 * the two standard vectors, which is what stops a reader and a writer sharing one wrong
 * implementation and agreeing with each other about a corrupt file.
 */
export function crc32(bytes: Uint8Array): number {
  const table = (crcTable ??= buildCrcTable());
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (table[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Entry names ──────────────────────────────────────────────────────────────

/**
 * Refuses a name that could escape, confuse a lookup, or corrupt a log line.
 *
 * This reader never writes a file, so classic zip-slip — `../../.ssh/authorized_keys` landing
 * outside the extraction directory — cannot happen here. The check is still absolute, for
 * three reasons that survive the "we only read into memory" argument:
 *
 *  - **Names are looked up.** `read('export.data')` compares strings. An archive containing
 *    both `export.data` and `./export.data`, or `files/../export.data`, gets to decide which
 *    one a naive lookup finds. Normalising instead of refusing means writing a path
 *    normaliser and being right about it; refusing means the question never arises.
 *  - **The caller may not stay in memory.** A future feature that saves an attachment
 *    inherits this reader's guarantees, and a guarantee added later is a guarantee that was
 *    absent for every release in between.
 *  - **A name is free-form attacker input in a security boundary.** A NUL truncates a C
 *    string; a `\r` rewrites a log line; an escape sequence repaints a terminal.
 *
 * Backslashes are refused outright rather than treated as separators. The ZIP specification
 * says the separator is `/`, so a backslash in a name is either a Windows writer being wrong
 * or somebody hoping a POSIX check will read `..\..\x` as a single harmless segment. Nothing
 * this reader needs to open contains one.
 */
function assertSafeEntryName(name: string, position: number): void {
  const at = `entry ${position}`;

  if (name === '') throw damaged(`${at} has an empty name`);
  if (name.length > MAX_ZIP_ENTRY_NAME_LENGTH) {
    throw damaged(`${at} has a name longer than the ${MAX_ZIP_ENTRY_NAME_LENGTH}-character limit`);
  }
  // Checked by code point rather than by a regex: a character class spelling out the control
  // range needs an `eslint-disable` for `no-control-regex`, and a disable comment sitting on a
  // security check is a disable comment somebody widens later.
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw damaged(`${at} has a name containing a control character`);
    }
  }
  if (name.includes('\\')) throw damaged(`${at} has a name containing a backslash`);
  if (name.startsWith('/')) throw damaged(`${at} has an absolute name`);
  if (/^[A-Za-z]:/.test(name)) throw damaged(`${at} has a name beginning with a drive letter`);

  const segments = name.split('/');
  segments.forEach((segment, index) => {
    // A trailing empty segment is the directory marker — `files/` splits to ['files', ''].
    // Anywhere else an empty segment means a doubled separator, which is a normalisation
    // question this reader declines to have an opinion about.
    const isDirectoryMarker = segment === '' && index === segments.length - 1 && index > 0;
    if (isDirectoryMarker) return;
    if (segment === '') throw damaged(`${at} has a name with an empty path segment`);
    if (segment === '.' || segment === '..') {
      throw damaged(`${at} has a name with a relative path segment`);
    }
  });
}

// ── Entries ──────────────────────────────────────────────────────────────────

export interface ZipEntry {
  /** Validated by {@link assertSafeEntryName}. Always `/`-separated, always UTF-8. */
  readonly name: string;
  /** True for the zero-length marker entries a writer emits for directories. */
  readonly isDirectory: boolean;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly crc32: number;
  /** 1-based, and the only way an error is allowed to identify an entry. */
  readonly position: number;
}

/** The name bytes are kept out of {@link ZipEntry} — only the reader compares them. */
interface CentralEntry extends ZipEntry {
  readonly nameBytes: Uint8Array;
  readonly localHeaderOffset: number;
}

// ── The archive ──────────────────────────────────────────────────────────────

export class ZipArchive {
  readonly #bytes: Uint8Array;
  readonly #limits: ZipLimits;
  readonly #entries: readonly CentralEntry[];
  readonly #byName: ReadonlyMap<string, CentralEntry>;
  /**
   * Bytes materialised so far, against {@link ZipLimits.maxTotalBytes}.
   *
   * Counted per *read*, not per distinct entry: reading the same entry twice spends the budget
   * twice. That is the conservative reading of "how much memory can this file cause", which is
   * the question the cap exists to answer.
   */
  #spentBytes = 0;

  private constructor(bytes: Uint8Array, limits: ZipLimits, entries: readonly CentralEntry[]) {
    this.#bytes = bytes;
    this.#limits = limits;
    this.#entries = entries;
    this.#byName = new Map(entries.map((entry) => [entry.name, entry]));
  }

  /**
   * Parses the central directory. Reads no entry data — that happens on demand in
   * {@link read}, so opening a 60 MiB archive to check whether it is a `.1pux` is cheap.
   */
  static open(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): ZipArchive {
    const resolved: ZipLimits = { ...DEFAULT_ZIP_LIMITS, ...limits };
    return new ZipArchive(bytes, resolved, readCentralDirectory(bytes, resolved));
  }

  get entries(): readonly ZipEntry[] {
    return this.#entries;
  }

  has(name: string): boolean {
    return this.#byName.has(name);
  }

  /** Every entry whose name starts with `prefix`. Directory markers included. */
  entriesUnder(prefix: string): readonly ZipEntry[] {
    return this.#entries.filter((entry) => entry.name.startsWith(prefix));
  }

  /**
   * Decompresses one entry.
   *
   * Throws rather than returning `null` for a missing name: every caller of this knows which
   * entry it wants and cannot continue without it, so a `null` would be checked in one place
   * and forgotten in the next.
   */
  read(name: string): Uint8Array {
    const entry = this.#byName.get(name);
    if (entry === undefined) throw damaged(`the archive has no entry called "${name}"`);
    return this.#readEntry(entry);
  }

  /** UTF-8, with a BOM removed — a Windows-written JSON entry can carry one. */
  readText(name: string): string {
    return stripBom(new TextDecoder('utf-8').decode(this.read(name)));
  }

  #readEntry(entry: CentralEntry): Uint8Array {
    const at = `entry ${entry.position}`;

    if (entry.isDirectory) throw damaged(`${at} is a directory and has no contents`);

    if (entry.compressionMethod !== ZIP_METHOD_STORED) {
      if (entry.compressionMethod !== ZIP_METHOD_DEFLATED) {
        throw damaged(
          `${at} uses compression method ${entry.compressionMethod}, and only stored (0) and deflated (8) entries can be read`
        );
      }
    }

    // Cap one: the *declared* size, refused before a byte is allocated. A header that lies
    // high never reaches zlib at all.
    if (entry.uncompressedSize > this.#limits.maxEntryBytes) {
      throw refusedSize(at, entry.uncompressedSize, this.#limits.maxEntryBytes);
    }
    const remainingBudget = this.#limits.maxTotalBytes - this.#spentBytes;
    if (entry.uncompressedSize > remainingBudget) {
      throw refusedSize(
        `${at} — the archive's entries together`,
        this.#spentBytes + entry.uncompressedSize,
        this.#limits.maxTotalBytes
      );
    }

    const compressed = this.#locateEntryData(entry);

    let inflated: Uint8Array;
    if (entry.compressionMethod === ZIP_METHOD_STORED) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw damaged(
          `${at} is stored uncompressed but declares two different sizes, ${entry.compressedSize} and ${entry.uncompressedSize}`
        );
      }
      inflated = compressed;
    } else {
      // Cap two: zlib's own ceiling, which is what actually stops a bomb. `maxOutputLength`
      // is the same mechanism `format/container.ts` uses on the vault body, and it is the
      // only one that survives a header declaring a modest size for an enormous stream.
      const ceiling = Math.min(this.#limits.maxEntryBytes, remainingBudget);
      inflated = inflateEntry(compressed, ceiling, at);
    }

    // A size that disagrees with the stream is not a rounding error; it is the directory
    // describing something other than what is there, and every downstream length check was
    // made against the directory's number.
    if (inflated.length !== entry.uncompressedSize) {
      throw damaged(
        `${at} declares ${entry.uncompressedSize} bytes but yielded ${inflated.length}`
      );
    }
    if (crc32(inflated) !== entry.crc32) {
      throw damaged(`${at} failed its CRC-32 checksum, so the archive is corrupt`);
    }

    this.#spentBytes += inflated.length;
    return inflated;
  }

  /**
   * Finds an entry's compressed bytes, via its **local** header.
   *
   * The data offset cannot be computed from the central directory alone: only the local
   * header knows how long its own name and extra fields are, and writers routinely put
   * different extra fields in the two places. Trusting the central copy's lengths here is the
   * classic way to read an entry from the wrong offset.
   *
   * The two names are then compared byte for byte. An archive whose directory says
   * `export.data` while the local header at that offset says something else is describing two
   * different files, and which one a reader gets is exactly the ambiguity an attacker wants.
   */
  #locateEntryData(entry: CentralEntry): Uint8Array {
    const at = `entry ${entry.position}`;
    const start = entry.localHeaderOffset;

    requireRange(this.#bytes, start, LOCAL_HEADER_FIXED_BYTES, `${at}'s local header`);
    if (readU32(this.#bytes, start, `${at}'s local header signature`) !== SIGNATURE_LOCAL_HEADER) {
      throw damaged(`${at} does not point at a local file header`);
    }

    const nameLength = readU16(this.#bytes, start + 26, `${at}'s local name length`);
    const extraLength = readU16(this.#bytes, start + 28, `${at}'s local extra length`);
    const nameStart = start + LOCAL_HEADER_FIXED_BYTES;

    requireRange(this.#bytes, nameStart, nameLength, `${at}'s local name`);
    const localName = this.#bytes.subarray(nameStart, nameStart + nameLength);
    if (!sameBytes(localName, entry.nameBytes)) {
      throw damaged(`${at} is named differently in the directory and in its local header`);
    }

    const dataStart = nameStart + nameLength + extraLength;
    // The declared-size-larger-than-the-file case, caught here rather than by an allocation.
    requireRange(this.#bytes, dataStart, entry.compressedSize, `${at}'s contents`);
    return this.#bytes.subarray(dataStart, dataStart + entry.compressedSize);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function inflateEntry(compressed: Uint8Array, ceiling: number, at: string): Uint8Array {
  try {
    // Raw DEFLATE: a ZIP entry carries no zlib or gzip wrapper, which is the entire reason
    // `node:zlib` is sufficient here.
    return new Uint8Array(inflateRawSync(Buffer.from(compressed), { maxOutputLength: ceiling }));
  } catch (cause) {
    if (isBufferTooLarge(cause)) throw refusedSize(at, ceiling + 1, ceiling);
    // Never let a raw zlib error escape: its message is written for a C programmer, and the
    // IPC layer would scrub it into "something went wrong" anyway.
    throw damaged(`${at} is not a valid compressed stream`);
  }
}

function isBufferTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE'
  );
}

// ── The central directory ────────────────────────────────────────────────────

interface EndOfCentralDirectory {
  readonly entryCount: number;
  readonly directoryOffset: number;
  readonly directorySize: number;
  readonly offset: number;
}

/**
 * Locates the End of Central Directory record.
 *
 * It is the last thing in the file, except for an optional comment of up to 64 KiB — so it is
 * found by scanning backwards, and the scan is bounded by that comment length rather than by
 * the file size. An unbounded backwards scan over a 60 MiB file that happens not to be a ZIP
 * is a guaranteed several-second freeze on a mistyped file.
 *
 * A signature match alone is not enough: those four bytes occur by chance in ordinary data,
 * and inside any ZIP that contains another ZIP. The comment length must also account for
 * exactly the bytes that follow, which is a four-byte coincidence plus an arithmetic identity
 * rather than a four-byte coincidence.
 */
function findEndOfCentralDirectory(bytes: Uint8Array): EndOfCentralDirectory {
  if (bytes.length < EOCD_FIXED_BYTES) {
    throw damaged(`the file is ${bytes.length} bytes, too small to be a ZIP archive`);
  }

  const earliest = Math.max(0, bytes.length - EOCD_FIXED_BYTES - MAX_ZIP_COMMENT_BYTES);
  for (let offset = bytes.length - EOCD_FIXED_BYTES; offset >= earliest; offset -= 1) {
    if (readU32(bytes, offset, 'the end of central directory record') !== SIGNATURE_EOCD) continue;
    const commentLength = readU16(bytes, offset + 20, 'the archive comment length');
    if (offset + EOCD_FIXED_BYTES + commentLength !== bytes.length) continue;

    const disk = readU16(bytes, offset + 4, 'the disk number');
    const directoryDisk = readU16(bytes, offset + 6, 'the directory disk number');
    if (disk !== 0 || directoryDisk !== 0) {
      throw damaged('the archive is split across several disks, which is not supported');
    }

    const onThisDisk = readU16(bytes, offset + 8, 'the entry count');
    const entryCount = readU16(bytes, offset + 10, 'the total entry count');
    if (onThisDisk !== entryCount) {
      throw damaged('the archive declares two different entry counts');
    }

    return {
      entryCount,
      directorySize: readU32(bytes, offset + 12, 'the directory size'),
      directoryOffset: readU32(bytes, offset + 16, 'the directory offset'),
      offset,
    };
  }

  throw damaged('it has no end-of-central-directory record, so it is not a ZIP archive');
}

/**
 * Refuses a ZIP64 archive, by name rather than by symptom.
 *
 * Without this the sentinel values would be read as literal sizes — a directory offset of
 * 4,294,967,295 in a 60 MiB file — and the user would be told their archive was truncated.
 * "This is a ZIP64 archive and Keyhold does not read those" is a sentence they can act on.
 */
function assertNotZip64(bytes: Uint8Array, eocd: EndOfCentralDirectory): void {
  const zip64 = 'the archive is in ZIP64 format, which Keyhold does not read';

  if (
    eocd.entryCount === ZIP64_MARKER_16 ||
    eocd.directoryOffset === ZIP64_MARKER_32 ||
    eocd.directorySize === ZIP64_MARKER_32
  ) {
    throw damaged(zip64);
  }

  // The ZIP64 locator sits immediately before the EOCD when one is present. Checking for it
  // catches the case where the 32-bit fields happen to fit but the archive is ZIP64 anyway.
  const locatorOffset = eocd.offset - 20;
  if (locatorOffset < 0) return;
  const signature = readU32(bytes, locatorOffset, 'the ZIP64 locator');
  if (signature === SIGNATURE_ZIP64_EOCD_LOCATOR || signature === SIGNATURE_ZIP64_EOCD) {
    throw damaged(zip64);
  }
}

function readCentralDirectory(bytes: Uint8Array, limits: ZipLimits): readonly CentralEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  assertNotZip64(bytes, eocd);

  if (eocd.entryCount > limits.maxEntries) {
    throw refusedSize('the archive directory', eocd.entryCount, limits.maxEntries);
  }

  const directoryEnd = eocd.directoryOffset + eocd.directorySize;
  if (directoryEnd > eocd.offset) {
    // The directory must lie wholly before the record that describes it. This is the check
    // that catches a bad directory offset, including one pointing past the end of the file.
    throw damaged('its central directory does not fit where the archive says it is');
  }

  const entries: CentralEntry[] = [];
  const seen = new Set<string>();
  let cursor = eocd.directoryOffset;

  for (let index = 0; index < eocd.entryCount; index += 1) {
    const position = index + 1;
    const at = `entry ${position}`;

    if (cursor + CENTRAL_HEADER_FIXED_BYTES > directoryEnd) {
      throw damaged(`the central directory ends before ${at}, which the archive says exists`);
    }
    if (readU32(bytes, cursor, `${at}'s directory header`) !== SIGNATURE_CENTRAL_HEADER) {
      throw damaged(`${at} is missing from the central directory`);
    }

    const flags = readU16(bytes, cursor + 8, `${at}'s flags`);
    if ((flags & FLAG_ENCRYPTED) !== 0 || (flags & FLAG_STRONG_ENCRYPTION) !== 0) {
      throw damaged(
        'the archive is password-protected, and Keyhold does not decrypt encrypted ZIP files'
      );
    }

    const compressedSize = readU32(bytes, cursor + 20, `${at}'s compressed size`);
    const uncompressedSize = readU32(bytes, cursor + 24, `${at}'s size`);
    const localHeaderOffset = readU32(bytes, cursor + 42, `${at}'s local header offset`);
    if (
      compressedSize === ZIP64_MARKER_32 ||
      uncompressedSize === ZIP64_MARKER_32 ||
      localHeaderOffset === ZIP64_MARKER_32
    ) {
      throw damaged(`${at} is stored in ZIP64 format, which Keyhold does not read`);
    }

    const nameLength = readU16(bytes, cursor + 28, `${at}'s name length`);
    const extraLength = readU16(bytes, cursor + 30, `${at}'s extra length`);
    const commentLength = readU16(bytes, cursor + 32, `${at}'s comment length`);
    const nameStart = cursor + CENTRAL_HEADER_FIXED_BYTES;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > directoryEnd) throw damaged(`${at} runs past the end of the central directory`);

    const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    const name = decodeEntryName(nameBytes, position);
    assertSafeEntryName(name, position);

    // Two entries with one name is not a formatting quirk: it is the archive choosing which
    // bytes a lookup returns, and every reader resolves it differently.
    if (seen.has(name)) throw damaged(`${at} repeats a name already used earlier in the archive`);
    seen.add(name);

    entries.push({
      name,
      isDirectory: name.endsWith('/'),
      compressionMethod: readU16(bytes, cursor + 10, `${at}'s compression method`),
      compressedSize,
      uncompressedSize,
      crc32: readU32(bytes, cursor + 16, `${at}'s checksum`),
      position,
      nameBytes,
      localHeaderOffset,
    });

    cursor = next;
  }

  // The other direction of the entry-count disagreement. Reading only as many entries as the
  // record declares would otherwise let an archive hide entries in plain sight: a lookup
  // would miss them, but so would any check that walked what the reader had found.
  if (
    cursor + 4 <= directoryEnd &&
    readU32(bytes, cursor, 'the byte after the last entry') === SIGNATURE_CENTRAL_HEADER
  ) {
    throw damaged(
      `the central directory holds more entries than the ${eocd.entryCount} the archive declares`
    );
  }

  return entries;
}

/**
 * UTF-8, strictly.
 *
 * A ZIP name is either UTF-8 (general-purpose flag bit 11) or CP437, and this reader supports
 * only the former. Decoding leniently would turn a CP437 name into replacement characters and
 * then fail a lookup for reasons the error message could not explain; `fatal` turns it into a
 * statement about the archive instead.
 */
function decodeEntryName(nameBytes: Uint8Array, position: number): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
  } catch {
    throw damaged(`entry ${position} has a name that is not valid UTF-8`);
  }
}

// ── Cheap identification ─────────────────────────────────────────────────────

/**
 * The first four bytes of a ZIP archive, for a parser's `detect`.
 *
 * `PK\x03\x04` is a local file header, which is what every non-empty archive starts with.
 * `PK\x05\x06` — an EOCD with nothing before it — is the empty archive, accepted here so that
 * "this is an empty ZIP" is reported as an empty ZIP rather than as an unrecognised file.
 */
export function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  const third = bytes[2];
  const fourth = bytes[3];
  return (third === 0x03 && fourth === 0x04) || (third === 0x05 && fourth === 0x06);
}
