// SPDX-License-Identifier: GPL-3.0-or-later
import { deflateRawSync } from 'node:zlib';
import { crc32, ZIP_METHOD_DEFLATED, ZIP_METHOD_STORED } from '../zip-reader.js';

/**
 * A deliberately **corruptible** ZIP writer, for tests only.
 *
 * Test support, like `load.ts` beside it — nothing in `src/main` outside a test imports this.
 *
 * ## Why a writer, when the project ships a reader
 *
 * The `.1pux` fixtures are built here rather than committed as binaries, for the same reason
 * `load.ts` applies CRLF in the test rather than checking in a CRLF file: a committed archive
 * is opaque. Nobody reviewing a diff can see what is inside one, `.gitattributes` cannot
 * normalise it, and — the part that matters — **a malformed archive cannot be committed at
 * all without somebody wondering whether it is malware**. Built here, every byte of every
 * fixture is visible in the test that uses it.
 *
 * ## Why every field has an override
 *
 * A ZIP reader's guards are all of the form "this field disagrees with that field". Proving
 * one works means writing an archive where they disagree, which a correct writer will never
 * do. So each override exists to serve exactly one fault injection, and each is named after
 * the disagreement it creates rather than after the field it sets. A writer that could only
 * produce valid archives would leave every guard in `zip-reader.ts` untested.
 *
 * Every value written by these helpers is invented. There are no real credentials here.
 */

const SIGNATURE_LOCAL_HEADER = 0x04034b50;
const SIGNATURE_CENTRAL_HEADER = 0x02014b50;
const SIGNATURE_EOCD = 0x06054b50;

export interface ZipFileSpec {
  readonly name: string;
  /** A string is written as UTF-8. */
  readonly data: Uint8Array | string;
  /** Stored (0) or deflated (8). Defaults to deflated, which is what 1Password writes. */
  readonly method?: typeof ZIP_METHOD_STORED | typeof ZIP_METHOD_DEFLATED;

  // ── Fault injections ──────────────────────────────────────────────────────
  /** Raw name bytes, for names no JavaScript string literal can carry safely. */
  readonly nameBytes?: Uint8Array;
  /** A different name in the local header than in the directory. */
  readonly localName?: string;
  /** A checksum that does not match the data: silent corruption. */
  readonly crc?: number;
  /** A directory size that disagrees with the stream. */
  readonly uncompressedSize?: number;
  /** A compressed size that runs past the end of the file. */
  readonly compressedSize?: number;
  /** General-purpose flags — bit 0 marks the entry encrypted. */
  readonly flags?: number;
  /** A compression method the reader does not implement. */
  readonly declaredMethod?: number;
  /** A local header offset pointing somewhere other than the entry. */
  readonly localHeaderOffset?: number;
}

export interface ZipOptions {
  /** An entry count in the EOCD that disagrees with the directory. */
  readonly declaredEntryCount?: number;
  /** Appended after the EOCD and counted in its comment-length field. */
  readonly comment?: string;
  /** Appended after everything, and **not** counted — so the EOCD arithmetic no longer holds. */
  readonly trailingGarbage?: Uint8Array;
  /** A central-directory offset that does not point at the directory. */
  readonly directoryOffset?: number;
  /** A central-directory size that does not match the directory. */
  readonly directorySize?: number;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  // `>>> 0` so a deliberately huge override such as 0xFFFFFFFF survives as unsigned.
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

interface PlacedEntry {
  readonly spec: ZipFileSpec;
  readonly nameBytes: Buffer;
  readonly method: number;
  readonly crc: number;
  readonly compressed: Buffer;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly flags: number;
  readonly offset: number;
}

export function buildZip(files: readonly ZipFileSpec[], options: ZipOptions = {}): Uint8Array {
  const localParts: Buffer[] = [];
  const placed: PlacedEntry[] = [];
  let offset = 0;

  for (const spec of files) {
    const raw = typeof spec.data === 'string' ? Buffer.from(spec.data, 'utf8') : spec.data;
    const data = Buffer.from(raw);
    const method = spec.method ?? ZIP_METHOD_DEFLATED;
    const compressed =
      method === ZIP_METHOD_STORED ? data : Buffer.from(deflateRawSync(data, { level: 9 }));

    const nameBytes =
      spec.nameBytes === undefined ? Buffer.from(spec.name, 'utf8') : Buffer.from(spec.nameBytes);
    const localNameBytes =
      spec.localName === undefined ? nameBytes : Buffer.from(spec.localName, 'utf8');

    const entry: PlacedEntry = {
      spec,
      nameBytes,
      method,
      crc: spec.crc ?? crc32(new Uint8Array(data)),
      compressed,
      compressedSize: spec.compressedSize ?? compressed.length,
      uncompressedSize: spec.uncompressedSize ?? data.length,
      // Bit 11 marks the name as UTF-8, which is what this writer always emits.
      flags: spec.flags ?? 0x0800,
      offset,
    };
    placed.push(entry);

    const header = Buffer.concat([
      u32(SIGNATURE_LOCAL_HEADER),
      u16(20), // version needed
      u16(entry.flags),
      u16(spec.declaredMethod ?? method),
      u16(0), // modification time
      u16(0), // modification date
      u32(entry.crc),
      u32(entry.compressedSize),
      u32(entry.uncompressedSize),
      u16(localNameBytes.length),
      u16(0), // extra length
      localNameBytes,
    ]);

    localParts.push(header, compressed);
    offset += header.length + compressed.length;
  }

  const directoryOffset = offset;
  const directoryParts: Buffer[] = [];

  for (const entry of placed) {
    directoryParts.push(
      Buffer.concat([
        u32(SIGNATURE_CENTRAL_HEADER),
        u16(20), // version made by
        u16(20), // version needed
        u16(entry.flags),
        u16(entry.spec.declaredMethod ?? entry.method),
        u16(0),
        u16(0),
        u32(entry.crc),
        u32(entry.compressedSize),
        u32(entry.uncompressedSize),
        u16(entry.nameBytes.length),
        u16(0), // extra length
        u16(0), // comment length
        u16(0), // disk number
        u16(0), // internal attributes
        u32(0), // external attributes
        u32(entry.spec.localHeaderOffset ?? entry.offset),
        entry.nameBytes,
      ])
    );
  }

  const directory = Buffer.concat(directoryParts);
  const comment = Buffer.from(options.comment ?? '', 'utf8');

  const eocd = Buffer.concat([
    u32(SIGNATURE_EOCD),
    u16(0), // this disk
    u16(0), // disk with the directory
    u16(options.declaredEntryCount ?? placed.length),
    u16(options.declaredEntryCount ?? placed.length),
    u32(options.directorySize ?? directory.length),
    u32(options.directoryOffset ?? directoryOffset),
    u16(comment.length),
    comment,
  ]);

  const trailing = Buffer.from(options.trailingGarbage ?? new Uint8Array(0));
  return new Uint8Array(Buffer.concat([...localParts, directory, eocd, trailing]));
}

/**
 * A highly compressible payload of `size` bytes.
 *
 * The zip-bomb tests need a stream whose inflated size is far larger than its compressed one,
 * without committing a bomb or spending a second building it. A run of one repeated byte
 * deflates to a few dozen bytes at any size.
 */
export function compressibleBytes(size: number): Uint8Array {
  return new Uint8Array(size).fill(0x41);
}
