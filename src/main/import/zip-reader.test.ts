// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VaultError, type VaultErrorCode } from '../crypto/errors.js';
import { buildZip, compressibleBytes } from './fixtures/zip-writer.js';
import {
  crc32,
  looksLikeZip,
  ZipArchive,
  ZIP_METHOD_DEFLATED,
  ZIP_METHOD_STORED,
} from './zip-reader.js';

/**
 * The ZIP reader's tests, which are mostly tests of **hostile** archives.
 *
 * A ZIP file is the only thing in this codebase that is simultaneously structured, entirely
 * attacker-chosen, and parsed before anything has authenticated it. The vault container is
 * structured and parsed early too, but it is a file this app wrote and its header is
 * authenticated; a `.1pux` is a file somebody else wrote, or somebody else's idea of a joke.
 *
 * So the happy path here is four tests and the rest are archives built to break one specific
 * guard each. Every one of those was verified by fault injection — the guard was removed, the
 * test was watched to fail, the guard was restored. The table is in the task report; the
 * injections are recorded per-test where the outcome was interesting.
 *
 * Nothing in this file is a real credential. Every payload is invented.
 */

function expectVaultError(run: () => unknown, code: VaultErrorCode, what: string): VaultError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `${what} did not throw`).toBeInstanceOf(VaultError);
  const error = thrown as VaultError;
  expect(error.code, `${what} threw ${error.code}: ${error.message}`).toBe(code);
  return error;
}

/** A well-formed two-entry archive, the shape of a `.1pux`. */
function goodArchive(): Uint8Array {
  return buildZip([
    { name: 'export.data', data: '{"accounts":[]}' },
    { name: 'files/', data: '', method: ZIP_METHOD_STORED },
    { name: 'files/note.txt', data: 'an attachment', method: ZIP_METHOD_STORED },
  ]);
}

describe('CRC-32', () => {
  it('matches the standard test vectors', () => {
    // Pinned against the two vectors every CRC-32 implementation is checked against. Without
    // this the reader and the test writer share one function, so a wrong implementation would
    // agree with itself and every checksum assertion below would pass on a corrupt file.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))).toBe(
      0x414fa339
    );
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('reading a well-formed archive', () => {
  it('lists every entry, with its sizes and its method', () => {
    const archive = ZipArchive.open(goodArchive());
    expect(archive.entries.map((entry) => entry.name)).toEqual([
      'export.data',
      'files/',
      'files/note.txt',
    ]);
    expect(archive.entries[0]?.compressionMethod).toBe(ZIP_METHOD_DEFLATED);
    expect(archive.entries[0]?.uncompressedSize).toBe(15);
    expect(archive.entries[1]?.isDirectory).toBe(true);
    expect(archive.entries[2]?.isDirectory).toBe(false);
  });

  it('inflates a deflated entry', () => {
    const text = JSON.stringify({ accounts: [{ vaults: [] }] });
    const archive = ZipArchive.open(buildZip([{ name: 'export.data', data: text }]));
    expect(archive.readText('export.data')).toBe(text);
  });

  it('copies a stored entry', () => {
    const archive = ZipArchive.open(
      buildZip([{ name: 'export.data', data: 'stored, not deflated', method: ZIP_METHOD_STORED }])
    );
    expect(archive.readText('export.data')).toBe('stored, not deflated');
  });

  it('round-trips bytes that are not text at all', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 0, 0, 80, 75, 3, 4]);
    const archive = ZipArchive.open(buildZip([{ name: 'blob.bin', data: bytes }]));
    expect(archive.read('blob.bin')).toEqual(bytes);
  });

  it('strips a BOM from decoded text, as a Windows-written entry would carry', () => {
    const archive = ZipArchive.open(buildZip([{ name: 'export.data', data: '\uFEFF{"a":1}' }]));
    expect(archive.readText('export.data')).toBe('{"a":1}');
  });

  it('finds the record past an archive comment', () => {
    // The end-of-central-directory record is not at a fixed offset — a comment pushes it back
    // by up to 64 KiB, which is why the scan is backwards rather than a single read.
    const archive = ZipArchive.open(
      buildZip([{ name: 'export.data', data: 'x' }], { comment: 'written by a tool that chats' })
    );
    expect(archive.readText('export.data')).toBe('x');
  });

  it('answers has() and entriesUnder() without reading anything', () => {
    const archive = ZipArchive.open(goodArchive());
    expect(archive.has('export.data')).toBe(true);
    expect(archive.has('Export.Data')).toBe(false);
    expect(archive.entriesUnder('files/').map((entry) => entry.name)).toEqual([
      'files/',
      'files/note.txt',
    ]);
  });

  it('reads an archive with no entries at all', () => {
    const archive = ZipArchive.open(buildZip([]));
    expect(archive.entries).toEqual([]);
    expect(archive.has('export.data')).toBe(false);
  });
});

describe('a file that is not a ZIP archive', () => {
  it('is refused when it is too short to hold a record', () => {
    expectVaultError(() => ZipArchive.open(new Uint8Array(4)), 'MALFORMED', 'a four-byte file');
  });

  it('is refused when nothing in it is an end-of-central-directory record', () => {
    const notAZip = new TextEncoder().encode('title,username,password\nExample,ada,hunter2\n');
    expectVaultError(() => ZipArchive.open(notAZip), 'MALFORMED', 'a CSV file');
  });

  it('is refused when the signature is there but the arithmetic is not', () => {
    // Fault injection: deleting the comment-length identity in `findEndOfCentralDirectory`
    // makes this pass, because the four signature bytes are present. The identity is what
    // separates a real record from four bytes of coincidence.
    const archive = buildZip([{ name: 'export.data', data: 'x' }]);
    const withTail = new Uint8Array([...archive, 0, 0, 0]);
    expectVaultError(
      () => ZipArchive.open(withTail),
      'MALFORMED',
      'an archive with unaccounted trailing bytes'
    );
  });

  it('does not scan a large non-archive from end to beginning', () => {
    /**
     * The backwards scan is bounded by the maximum comment length, not by the file size, so a
     * 40 MiB mistyped file fails immediately rather than making the wizard think.
     *
     * Asserted by **counting reads** rather than by timing. The first version of this test
     * timed the call and allowed two seconds, and a fault injection setting the scan's floor
     * to zero — an unbounded scan over all 40 MiB — passed it comfortably at 163 ms against
     * 16 ms bounded. A timing assertion loose enough not to flake on a slow machine is loose
     * enough not to notice a factor of ten, which is the whole difference this guard makes.
     *
     * The counting proxy is exact: the window is 65,557 possible positions and each costs four
     * index reads, so a bounded scan cannot exceed about 262,000. An unbounded one over this
     * file would take 160 million.
     */
    let reads = 0;
    const counted = new Proxy(compressibleBytes(40 * 1024 * 1024), {
      get(target, key): unknown {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        // The receiver is deliberately left as the target: a typed array's `length` getter
        // refuses to run with a Proxy as its `this`.
        return Reflect.get(target, key) as unknown;
      },
    });

    expectVaultError(() => ZipArchive.open(counted), 'MALFORMED', 'a 40 MiB non-archive');
    expect(reads).toBeLessThan(400_000);
  });

  it('recognises the signature cheaply, for a parser’s detect', () => {
    expect(looksLikeZip(goodArchive())).toBe(true);
    expect(looksLikeZip(buildZip([]))).toBe(true); // an empty archive starts with the EOCD
    expect(looksLikeZip(new TextEncoder().encode('title,url\n'))).toBe(false);
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b]))).toBe(false);
    expect(looksLikeZip(new Uint8Array(0))).toBe(false);
  });
});

describe('a malformed archive', () => {
  it('is refused when it has been truncated', () => {
    const truncated = goodArchive().slice(0, 40);
    expectVaultError(() => ZipArchive.open(truncated), 'MALFORMED', 'a truncated archive');
  });

  it('is refused when the directory offset points nowhere', () => {
    const bad = buildZip([{ name: 'export.data', data: 'x' }], { directoryOffset: 0xfffffff0 });
    expectVaultError(() => ZipArchive.open(bad), 'MALFORMED', 'a directory offset past the file');
  });

  it('is refused when the directory size runs past the record that describes it', () => {
    const bad = buildZip([{ name: 'export.data', data: 'x' }], { directorySize: 1_000_000 });
    expectVaultError(() => ZipArchive.open(bad), 'MALFORMED', 'an oversized directory');
  });

  it('is refused when the declared entry count is higher than the directory holds', () => {
    const bad = buildZip([{ name: 'export.data', data: 'x' }], { declaredEntryCount: 3 });
    expectVaultError(() => ZipArchive.open(bad), 'MALFORMED', 'a count higher than the directory');
  });

  it('is refused when the declared entry count hides an entry', () => {
    // The direction that matters more. Reading only as many entries as the record declares
    // would let an archive carry an entry that no lookup finds and no audit walks — the
    // reader would report two entries and the file would contain three.
    const bad = buildZip(
      [
        { name: 'export.data', data: 'x' },
        { name: 'hidden.data', data: 'y' },
      ],
      { declaredEntryCount: 1 }
    );
    expectVaultError(() => ZipArchive.open(bad), 'MALFORMED', 'a hidden entry');
  });

  it('is refused when an entry declares more bytes than the file contains', () => {
    const bad = buildZip([{ name: 'export.data', data: 'x', compressedSize: 5_000 }]);
    const archive = ZipArchive.open(bad);
    expectVaultError(() => archive.read('export.data'), 'MALFORMED', 'a size past the file end');
  });

  it('is refused when a local header offset points at something else', () => {
    const bad = buildZip([{ name: 'export.data', data: 'x', localHeaderOffset: 3 }]);
    const archive = ZipArchive.open(bad);
    expectVaultError(() => archive.read('export.data'), 'MALFORMED', 'a misdirected offset');
  });

  it('is refused when the two copies of a name disagree', () => {
    // The directory says one file, the bytes at that offset are another. Which one a reader
    // returns is precisely the ambiguity worth having no opinion about.
    const bad = buildZip([{ name: 'export.data', data: 'x', localName: 'something.else' }]);
    const archive = ZipArchive.open(bad);
    expectVaultError(() => archive.read('export.data'), 'MALFORMED', 'a name mismatch');
  });

  it('is refused when the checksum does not match the contents', () => {
    const bad = buildZip([{ name: 'export.data', data: 'x', crc: 0x12345678 }]);
    const archive = ZipArchive.open(bad);
    const error = expectVaultError(() => archive.read('export.data'), 'MALFORMED', 'a bad CRC');
    expect(error.message).toContain('CRC-32');
  });

  it('is refused when the declared size disagrees with the stream', () => {
    const bad = buildZip([{ name: 'export.data', data: 'a longer payload', uncompressedSize: 3 }]);
    const archive = ZipArchive.open(bad);
    expectVaultError(() => archive.read('export.data'), 'MALFORMED', 'a size that disagrees');
  });

  it('is refused when the compressed stream is not DEFLATE at all', () => {
    const bad = buildZip([
      { name: 'export.data', data: 'x', method: ZIP_METHOD_STORED, declaredMethod: 8 },
    ]);
    const archive = ZipArchive.open(bad);
    expectVaultError(() => archive.read('export.data'), 'MALFORMED', 'a bogus stream');
  });

  it('is refused when a stored entry declares two different sizes', () => {
    const bad = buildZip([
      { name: 'export.data', data: 'stored', method: ZIP_METHOD_STORED, compressedSize: 3 },
    ]);
    const archive = ZipArchive.open(bad);
    expectVaultError(() => archive.read('export.data'), 'MALFORMED', 'a stored size disagreement');
  });

  it('is refused when the same name appears twice', () => {
    const bad = buildZip([
      { name: 'export.data', data: 'first' },
      { name: 'export.data', data: 'second' },
    ]);
    expectVaultError(() => ZipArchive.open(bad), 'MALFORMED', 'a duplicated name');
  });

  it('names the missing entry rather than returning nothing', () => {
    const archive = ZipArchive.open(goodArchive());
    expectVaultError(() => archive.read('nope.data'), 'MALFORMED', 'a missing entry');
  });

  it('refuses to read a directory marker as a file', () => {
    const archive = ZipArchive.open(goodArchive());
    expectVaultError(() => archive.read('files/'), 'MALFORMED', 'a directory entry');
  });
});

describe('an archive this reader deliberately does not support', () => {
  it('refuses an encrypted entry, by name', () => {
    const bad = buildZip([{ name: 'export.data', data: 'x', flags: 0x0801 }]);
    const error = expectVaultError(() => ZipArchive.open(bad), 'MALFORMED', 'an encrypted entry');
    expect(error.message).toContain('password-protected');
  });

  it('refuses a compression method it does not implement', () => {
    // Method 12 is bzip2. Refusing by number rather than attempting an inflate is what makes
    // the message actionable — "re-export as a normal .1pux" rather than "corrupt file".
    const bad = buildZip([
      { name: 'export.data', data: 'x', method: ZIP_METHOD_STORED, declaredMethod: 12 },
    ]);
    const archive = ZipArchive.open(bad);
    const error = expectVaultError(() => archive.read('export.data'), 'MALFORMED', 'bzip2');
    expect(error.message).toContain('compression method 12');
  });

  it('refuses a ZIP64 entry by name rather than reporting a truncated file', () => {
    const bad = buildZip([{ name: 'export.data', data: 'x', uncompressedSize: 0xffffffff }]);
    const error = expectVaultError(() => ZipArchive.open(bad), 'MALFORMED', 'a ZIP64 entry');
    expect(error.message).toContain('ZIP64');
  });

  it('refuses a ZIP64 archive whose 32-bit fields happen to fit', () => {
    // The locator sits immediately before the record. An archive can be ZIP64 while every
    // 32-bit field still holds a real value, and without this check it would be read as a
    // plain archive and silently misinterpreted.
    const plain = Buffer.from(buildZip([{ name: 'export.data', data: 'x' }]));
    const eocdOffset = plain.length - 22;
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    const withLocator = Buffer.concat([
      plain.subarray(0, eocdOffset),
      locator,
      plain.subarray(eocdOffset),
    ]);
    const error = expectVaultError(
      () => ZipArchive.open(new Uint8Array(withLocator)),
      'MALFORMED',
      'a ZIP64 locator'
    );
    expect(error.message).toContain('ZIP64');
  });
});

describe('entry names', () => {
  /** Each of these is refused at `open`, before any lookup can be confused by it. */
  const REJECTED: readonly (readonly [string, ZipFileName])[] = [
    ['a parent-directory segment', { name: '../export.data' }],
    ['a parent-directory segment in the middle', { name: 'files/../../export.data' }],
    ['a current-directory segment', { name: './export.data' }],
    ['an absolute POSIX path', { name: '/etc/passwd' }],
    ['a Windows drive letter', { name: 'C:/Windows/system32/x.dll' }],
    ['a backslash separator', { name: 'files\\note.txt' }],
    ['a UNC path', { name: '\\\\server\\share\\x' }],
    ['a doubled separator', { name: 'files//note.txt' }],
    ['an empty name', { nameBytes: new Uint8Array(0), name: '' }],
    [
      'an embedded NUL',
      { nameBytes: new TextEncoder().encode('export.data\u0000.png'), name: 'x' },
    ],
    ['a carriage return', { nameBytes: new TextEncoder().encode('export\r\n.data'), name: 'x' }],
    ['bytes that are not UTF-8', { nameBytes: new Uint8Array([0xff, 0xfe, 0x41]), name: 'x' }],
    ['a name longer than the limit', { name: `${'a'.repeat(1025)}.data` }],
  ];

  interface ZipFileName {
    readonly name: string;
    readonly nameBytes?: Uint8Array;
  }

  it.each(REJECTED)('refuses %s', (_what, spec) => {
    const archive = buildZip([
      spec.nameBytes === undefined
        ? { name: spec.name, data: 'x' }
        : { name: spec.name, nameBytes: spec.nameBytes, data: 'x' },
    ]);
    expectVaultError(() => ZipArchive.open(archive), 'MALFORMED', `the name for "${_what}"`);
  });

  it('accepts the shapes a real .1pux uses', () => {
    const archive = ZipArchive.open(
      buildZip([
        { name: 'export.data', data: 'x' },
        { name: 'export.attributes', data: 'y' },
        { name: 'files/', data: '', method: ZIP_METHOD_STORED },
        { name: 'files/4bd8d0e6__passport.pdf', data: 'z' },
        { name: 'files/a b c — unicode ✓.png', data: 'w' },
      ])
    );
    expect(archive.entries).toHaveLength(5);
  });

  it('never puts an entry name in the error it throws', () => {
    // An entry name inside a `.1pux` is the user's own attachment filename, and an error is
    // read in every place a warning is — the screen, the report, a pasted bug report. Hard
    // rule 1 covers it, and referring to entries by position is what makes that automatic.
    const secretish = 'files/divorce-settlement-final.pdf';
    const archive = buildZip([
      { name: 'export.data', data: 'x' },
      { name: secretish, data: 'y', crc: 0xdeadbeef },
    ]);
    const opened = ZipArchive.open(archive);
    const error = expectVaultError(() => opened.read(secretish), 'MALFORMED', 'a bad CRC');
    expect(error.message).not.toContain('divorce');
    expect(error.message).toContain('entry 2');
  });
});

describe('the size caps', () => {
  it('refuses an entry whose declared size is over the per-entry cap', () => {
    const archive = ZipArchive.open(
      buildZip([{ name: 'big.bin', data: compressibleBytes(4 * 1024 * 1024) }]),
      { maxEntryBytes: 1024 * 1024 }
    );
    const error = expectVaultError(
      () => archive.read('big.bin'),
      'TOO_LARGE',
      'an oversized entry'
    );
    expect(error.message).toContain('safety limit');
  });

  it('refuses an entry that merely claims to be enormous', () => {
    /**
     * Isolates the **declared**-size check from zlib's ceiling, which is not a distinction the
     * previous test could make.
     *
     * The stream here is a hundred bytes and only the header claims eight megabytes, so zlib
     * would inflate it without complaint. Deleting the declared-size check therefore does not
     * produce a refusal at all — it produces a `MALFORMED` from the size-mismatch check two
     * steps later, which is a different answer to a different question. Asserting the code,
     * not merely that something threw, is what makes the two guards separable. A fault
     * injection against the first version of this suite removed the declared check and
     * nothing failed.
     */
    const archive = ZipArchive.open(
      buildZip([
        { name: 'liar.bin', data: compressibleBytes(100), uncompressedSize: 8 * 1024 * 1024 },
      ]),
      { maxEntryBytes: 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 }
    );
    expectVaultError(() => archive.read('liar.bin'), 'TOO_LARGE', 'an entry claiming to be huge');
  });

  it('refuses an entry that claims more than the archive’s remaining budget', () => {
    // The same isolation for the whole-archive budget: under the per-entry cap, over the
    // total, and small enough that zlib would never object.
    const archive = ZipArchive.open(
      buildZip([
        { name: 'liar.bin', data: compressibleBytes(100), uncompressedSize: 4 * 1024 * 1024 },
      ]),
      { maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 1024 * 1024 }
    );
    expectVaultError(() => archive.read('liar.bin'), 'TOO_LARGE', 'an entry over the budget');
  });

  it('refuses a stream that lies about its size, using zlib’s own ceiling', () => {
    // The load-bearing half of the defence. The declared-size check believes the header; this
    // one does not. A four-megabyte stream declaring a thousand bytes gets past the first
    // check and is stopped by `maxOutputLength` — which is exactly the shape of a zip bomb.
    const archive = ZipArchive.open(
      buildZip([
        { name: 'bomb.bin', data: compressibleBytes(4 * 1024 * 1024), uncompressedSize: 1000 },
      ]),
      { maxEntryBytes: 1024 * 1024 }
    );
    expectVaultError(() => archive.read('bomb.bin'), 'TOO_LARGE', 'a lying header');
  });

  it('refuses to spend more than the whole-archive budget across several entries', () => {
    // Each entry is under the per-entry cap. Together they are not, which is how a bomb is
    // built once a per-entry cap exists.
    const archive = ZipArchive.open(
      buildZip([
        { name: 'a.bin', data: compressibleBytes(600 * 1024) },
        { name: 'b.bin', data: compressibleBytes(600 * 1024) },
      ]),
      { maxEntryBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024 }
    );
    expect(archive.read('a.bin')).toHaveLength(600 * 1024);
    expectVaultError(() => archive.read('b.bin'), 'TOO_LARGE', 'the second read');
  });

  it('refuses a directory declaring more entries than the cap allows', () => {
    // Checked from the record, before the walk, so a declared count of four billion cannot
    // drive an allocation or a four-billion-iteration loop.
    const archive = buildZip([{ name: 'export.data', data: 'x' }], { declaredEntryCount: 60_000 });
    expectVaultError(
      () => ZipArchive.open(archive, { maxEntries: 8 }),
      'TOO_LARGE',
      'a huge count'
    );
  });

  it('lets a genuine archive through the caps untouched', () => {
    const archive = ZipArchive.open(
      buildZip([
        { name: 'a.bin', data: compressibleBytes(200 * 1024) },
        { name: 'b.bin', data: compressibleBytes(200 * 1024) },
      ]),
      { maxEntryBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024 }
    );
    expect(archive.read('a.bin')).toHaveLength(200 * 1024);
    expect(archive.read('b.bin')).toHaveLength(200 * 1024);
  });
});
