// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VaultError, type VaultErrorCode } from '../crypto/errors.js';
import { ByteWriter } from './binary.js';
import { KDF_ARGON2D, MAX_HEADER_FIELD, uuidHex, type VariantValue } from './types.js';
import { readVariantDictionary, writeVariantDictionary } from './variant-dictionary.js';

/**
 * The `VariantDictionary`'s tests, which are mostly tests of dictionaries built to be wrong.
 *
 * This structure decides how the master key is derived, so its failure mode is not a parse
 * error — it is a **wrong key reported as a wrong password**, on a database the user cannot
 * then open and cannot diagnose. Every refusal in `variant-dictionary.ts` exists to make that
 * outcome impossible, so the majority of this file is one fixture per guard.
 *
 * Every one of those guards was verified by fault injection: the guard was broken with the
 * exact bug the test claims to catch, the test was watched to fail, the guard was restored.
 * The table is in the task report.
 *
 * Nothing here is a real credential. The "salt" is a counting sequence and the string values
 * are invented; they exist so the final property test has something recognisable to hunt for
 * in an error message.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TYPE_END = 0x00;
const TYPE_UINT32 = 0x04;
const TYPE_UINT64 = 0x05;
const TYPE_BOOL = 0x08;
const TYPE_INT32 = 0x0c;
const TYPE_INT64 = 0x0d;
const TYPE_STRING = 0x18;
const TYPE_BYTE_ARRAY = 0x42;

/**
 * `0x0100`, written out rather than imported.
 *
 * The module deliberately does not export its version constant, and this test deliberately
 * does not want it to: a test that reuses the constant under test agrees with it whatever it
 * says, and would pass just as happily against a reader that wrote 0x0200.
 */
const FORMAT_VERSION = 0x0100;

/** The offset of the first item's type byte — straight after the `uint16` version. */
const FIRST_TYPE_BYTE = 2;

const encoder = new TextEncoder();

interface RawItem {
  readonly type: number;
  readonly key: string;
  readonly value: Uint8Array;
  /** Overrides what the item *claims* its name is, without changing the bytes written. */
  readonly declaredKeyLength?: number;
  /** Overrides what the item *claims* its value is. This is how a bomb is built. */
  readonly declaredValueLength?: number;
}

interface RawOptions {
  readonly version?: number;
  /** `false` leaves the terminating `0x00` off, which is the truncated-list fixture. */
  readonly terminate?: boolean;
  readonly trailing?: Uint8Array;
}

/**
 * Builds dictionary bytes field by field, including impossible ones.
 *
 * The writer under test cannot produce a malformed dictionary — that is the point of it — so
 * the hostile fixtures have to be assembled here. `ByteWriter` is reused because a second
 * little-endian appender in this file would be one more thing that can be wrong.
 */
function buildRaw(items: readonly RawItem[], options: RawOptions = {}): Uint8Array {
  const chunks: Uint8Array[] = [new ByteWriter().u16(options.version ?? FORMAT_VERSION).finish()];

  for (const item of items) {
    const keyBytes = encoder.encode(item.key);
    chunks.push(
      new ByteWriter()
        .u8(item.type)
        .u32(item.declaredKeyLength ?? keyBytes.length)
        .finish(),
      keyBytes,
      new ByteWriter().u32(item.declaredValueLength ?? item.value.length).finish(),
      item.value
    );
  }

  if (options.terminate !== false) chunks.push(Uint8Array.of(TYPE_END));
  if (options.trailing !== undefined) chunks.push(options.trailing);
  return concat(chunks);
}

/** One allocation of the exact size, so a fixture is never limited by a builder's buffer. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const u32Bytes = (value: number): Uint8Array => new ByteWriter().u32(value).finish();
const u64Bytes = (value: bigint): Uint8Array => new ByteWriter().u64(value).finish();

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

/** The type tag a single-value dictionary chose, read straight back out of the bytes. */
function tagWrittenFor(value: VariantValue): number {
  const bytes = writeVariantDictionary(new Map([['k', value]]));
  return bytes[FIRST_TYPE_BYTE] ?? -1;
}

// ── The happy path ───────────────────────────────────────────────────────────

describe('round-tripping every type', () => {
  it('preserves the value and the JavaScript type of all seven tags', () => {
    const source = new Map<string, VariantValue>([
      ['bool-true', true],
      ['bool-false', false],
      ['uint32', 0xffff_fffe],
      ['uint32-zero', 0],
      ['int32', -2_000_000_001],
      ['uint64', 0xffff_ffff_ffff_fffen],
      ['int64', -9_007_199_254_740_993n],
      ['string', 'a value with an emoji 🔐 and ümlauts'],
      ['string-empty', ''],
      ['bytes', new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff])],
      ['bytes-empty', new Uint8Array(0)],
      ['key with spaces and $ and 名前', 'reachable'],
    ]);

    const round = readVariantDictionary(writeVariantDictionary(source));

    expect(round).toEqual(source);
    // Order is not required by the format, but it is preserved, so that writing a file back
    // out produces the same bytes rather than a gratuitous diff.
    expect([...round.keys()]).toEqual([...source.keys()]);
    // `toEqual` would accept 5 for 5n, so the two 64-bit values are asserted by type as well.
    expect(typeof round.get('uint64')).toBe('bigint');
    expect(typeof round.get('int64')).toBe('bigint');
    expect(typeof round.get('uint32')).toBe('number');
    expect(round.get('bytes')).toBeInstanceOf(Uint8Array);
  });

  it('picks the narrowest correct tag for each JavaScript value', () => {
    expect(tagWrittenFor(true)).toBe(TYPE_BOOL);
    expect(tagWrittenFor(0)).toBe(TYPE_UINT32);
    expect(tagWrittenFor(0xffff_ffff)).toBe(TYPE_UINT32);
    expect(tagWrittenFor(-1)).toBe(TYPE_INT32);
    expect(tagWrittenFor(0n)).toBe(TYPE_UINT64);
    expect(tagWrittenFor(-1n)).toBe(TYPE_INT64);
    expect(tagWrittenFor('text')).toBe(TYPE_STRING);
    expect(tagWrittenFor(new Uint8Array(4))).toBe(TYPE_BYTE_ARRAY);
  });

  it('accepts a minor version bump but keeps writing the version it knows', () => {
    // Minor bumps add items; they do not change the framing. Refusing 1.1 would refuse a file
    // a future KeePass writes for no reason this reader could defend.
    const bumped = buildRaw([{ type: TYPE_UINT32, key: 'P', value: u32Bytes(4) }], {
      version: 0x0107,
    });
    expect(readVariantDictionary(bumped).get('P')).toBe(4);
    expect(writeVariantDictionary(new Map())[1]).toBe(FORMAT_VERSION >>> 8);
  });

  it('round-trips a dictionary far larger than any append buffer', () => {
    // A deliberate guard rather than a size for its own sake. The first version of this module
    // assembled its output with an appending writer and worked perfectly on the ~140-byte
    // dictionary a real Argon2 file carries, while being unable to write anything past a
    // buffer boundary at all — a bug no test of a realistic KDF parameter set can see.
    const source = new Map<string, VariantValue>([
      ['blob', Uint8Array.from({ length: 4096 }, (_, index) => index & 0xff)],
      ['long', 'x'.repeat(5000)],
      ['after', 42],
    ]);
    const bytes = writeVariantDictionary(source);
    expect(bytes.length).toBeGreaterThan(9000);
    expect(readVariantDictionary(bytes)).toEqual(source);
  });

  it('reads a value the writer would never produce: an empty dictionary', () => {
    expect(readVariantDictionary(buildRaw([]))).toEqual(new Map());
    expect(writeVariantDictionary(new Map())).toEqual(buildRaw([]));
  });

  it('treats any non-zero byte as a true Bool', () => {
    const raw = buildRaw([{ type: TYPE_BOOL, key: 'flag', value: Uint8Array.of(0x7f) }]);
    expect(readVariantDictionary(raw).get('flag')).toBe(true);
  });
});

describe('a real Argon2d parameter set', () => {
  /** `$UUID`, `S`, `I`, `M`, `P`, `V` — exactly what KeePassXC writes for its default KDF. */
  const argon2Uuid = Uint8Array.from(Buffer.from(KDF_ARGON2D, 'hex'));
  const salt = Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 3) & 0xff);

  const bytes = buildRaw([
    { type: TYPE_BYTE_ARRAY, key: '$UUID', value: argon2Uuid },
    { type: TYPE_BYTE_ARRAY, key: 'S', value: salt },
    { type: TYPE_UINT64, key: 'I', value: u64Bytes(10n) },
    { type: TYPE_UINT64, key: 'M', value: u64Bytes(67_108_864n) },
    { type: TYPE_UINT32, key: 'P', value: u32Bytes(4) },
    { type: TYPE_UINT32, key: 'V', value: u32Bytes(0x13) },
  ]);

  it('parses each parameter at the type the KDF reader will expect', () => {
    const parsed = readVariantDictionary(bytes);

    expect(uuidHex(parsed.get('$UUID') as Uint8Array)).toBe(KDF_ARGON2D);
    expect(parsed.get('S')).toEqual(salt);
    expect(parsed.get('I')).toBe(10n);
    expect(parsed.get('M')).toBe(67_108_864n);
    expect(parsed.get('P')).toBe(4);
    expect(parsed.get('V')).toBe(0x13);
  });

  it('re-writes it byte for byte', () => {
    // The tag-narrowing rule is only harmless if it is a no-op on the one dictionary that
    // matters. A `.kdbx` Keyhold saves back must be one KeePassXC still opens.
    expect(writeVariantDictionary(readVariantDictionary(bytes))).toEqual(bytes);
  });

  it('hands back a copy of the salt, not a window onto the file buffer', () => {
    // The KDF reader zeroes the salt when it is done. A subarray would zero the caller's file
    // bytes instead — or, worse, would leave the salt alive somewhere nobody thinks holds one.
    const parsed = readVariantDictionary(bytes);
    (parsed.get('S') as Uint8Array).fill(0);
    expect(readVariantDictionary(bytes).get('S')).toEqual(salt);
  });
});

// ── Refusals ─────────────────────────────────────────────────────────────────

describe('refusing a version it does not understand', () => {
  it('names the major version rather than reporting damage', () => {
    const error = expectVaultError(
      () => readVariantDictionary(buildRaw([], { version: 0x0200 })),
      'MALFORMED',
      'a format-2 dictionary'
    );
    expect(error.message).toContain('format 2');
    expect(error.message).toContain('format 1');
  });

  it('refuses major version 0 as well as a future one', () => {
    expectVaultError(
      () => readVariantDictionary(buildRaw([], { version: 0x0001 })),
      'MALFORMED',
      'a format-0 dictionary'
    );
  });

  it('refuses a file too short to hold a version', () => {
    expectVaultError(
      () => readVariantDictionary(Uint8Array.of(0x00)),
      'MALFORMED',
      'a one-byte dictionary'
    );
  });
});

describe('refusing an unknown type', () => {
  it('refuses rather than skipping the item', () => {
    // The single most consequential refusal here: skipping this item would drop a KDF
    // parameter, derive a different key, and report a correct password as wrong.
    const raw = buildRaw([
      { type: TYPE_UINT32, key: 'P', value: u32Bytes(4) },
      { type: 0x99, key: 'M', value: u64Bytes(65_536n) },
    ]);
    const error = expectVaultError(
      () => readVariantDictionary(raw),
      'MALFORMED',
      'an unknown type byte'
    );
    expect(error.message).toContain('0x99');
    expect(error.message).toContain('"M"');
  });

  it('refuses a type that is plausible but not in the set', () => {
    // 0x0B sits between Int32 (0x0C) and UInt64 (0x05) and is exactly the sort of value a
    // typo'd writer emits. There is no "close enough" reading of it.
    expectVaultError(
      () => readVariantDictionary(buildRaw([{ type: 0x0b, key: 'I', value: u32Bytes(1) }])),
      'MALFORMED',
      'type 0x0b'
    );
  });
});

describe('refusing a duplicate key', () => {
  it('refuses rather than letting the last one win', () => {
    // Both readings — first wins, last wins — are defensible, which is the problem: the file
    // would get to choose which memory cost each implementation derives its key from.
    const raw = buildRaw([
      { type: TYPE_UINT64, key: 'M', value: u64Bytes(67_108_864n) },
      { type: TYPE_UINT64, key: 'M', value: u64Bytes(1_024n) },
    ]);
    const error = expectVaultError(() => readVariantDictionary(raw), 'MALFORMED', 'a repeated key');
    expect(error.message).toContain('"M"');
    expect(error.message).toContain('more than once');
  });

  it('refuses a duplicate even when the two values are identical', () => {
    const raw = buildRaw([
      { type: TYPE_UINT32, key: 'P', value: u32Bytes(4) },
      { type: TYPE_UINT32, key: 'P', value: u32Bytes(4) },
    ]);
    expectVaultError(() => readVariantDictionary(raw), 'MALFORMED', 'an identical repeat');
  });

  it('refuses a duplicate written under a different type', () => {
    const raw = buildRaw([
      { type: TYPE_UINT32, key: 'I', value: u32Bytes(10) },
      { type: TYPE_UINT64, key: 'I', value: u64Bytes(10n) },
    ]);
    expectVaultError(() => readVariantDictionary(raw), 'MALFORMED', 'a retyped repeat');
  });
});

describe('refusing a truncated dictionary', () => {
  const good = buildRaw([
    { type: TYPE_BYTE_ARRAY, key: 'S', value: new Uint8Array(32) },
    { type: TYPE_UINT64, key: 'M', value: u64Bytes(67_108_864n) },
  ]);

  it('refuses a file that stops part-way through a value', () => {
    const error = expectVaultError(
      () => readVariantDictionary(good.subarray(0, good.length - 4)),
      'MALFORMED',
      'a truncated value'
    );
    expect(error.message).toContain('ends part-way through');
  });

  it('refuses a file that stops part-way through a key', () => {
    expectVaultError(
      () => readVariantDictionary(good.subarray(0, 8)),
      'MALFORMED',
      'a truncated key'
    );
  });

  it('refuses a list with no terminating type byte', () => {
    const error = expectVaultError(
      () =>
        readVariantDictionary(
          buildRaw([{ type: TYPE_UINT32, key: 'P', value: u32Bytes(4) }], { terminate: false })
        ),
      'MALFORMED',
      'an unterminated list'
    );
    expect(error.message).toContain('terminating type byte');
  });

  it('refuses bytes after the terminator', () => {
    const raw = buildRaw([{ type: TYPE_UINT32, key: 'P', value: u32Bytes(4) }], {
      trailing: Uint8Array.of(0x04, 0x01, 0x00),
    });
    expectVaultError(() => readVariantDictionary(raw), 'MALFORMED', 'a trailing fragment');
  });
});

describe('refusing a declared length above the ceiling', () => {
  it('refuses an enormous value length before allocating for it', () => {
    // 4 GiB declared in a 20-byte file. Without the bound this is a `MALFORMED` truncation —
    // a true statement about a file that is really an allocation bomb.
    const raw = buildRaw([
      {
        type: TYPE_BYTE_ARRAY,
        key: 'S',
        value: new Uint8Array(4),
        declaredValueLength: 0xffff_ffff,
      },
    ]);
    const error = expectVaultError(() => readVariantDictionary(raw), 'TOO_LARGE', 'a 4 GiB value');
    expect(error.message).toContain('4294967295');
    expect(error.message).toContain('"S"');
  });

  it('refuses an enormous key length before allocating for it', () => {
    const raw = buildRaw([
      { type: TYPE_UINT32, key: 'P', value: u32Bytes(4), declaredKeyLength: 0xffff_ffff },
    ]);
    expectVaultError(() => readVariantDictionary(raw), 'TOO_LARGE', 'a 4 GiB key');
  });

  it('draws the line exactly at MAX_HEADER_FIELD', () => {
    // The boundary is asserted from both sides so that the check stays `>` rather than
    // drifting to `>=`, which would refuse a field the format permits.
    const atCeiling = buildRaw([
      {
        type: TYPE_BYTE_ARRAY,
        key: 'S',
        value: new Uint8Array(4),
        declaredValueLength: MAX_HEADER_FIELD,
      },
    ]);
    const overCeiling = buildRaw([
      {
        type: TYPE_BYTE_ARRAY,
        key: 'S',
        value: new Uint8Array(4),
        declaredValueLength: MAX_HEADER_FIELD + 1,
      },
    ]);

    // At the ceiling the length is believed, and the file is then merely truncated.
    expectVaultError(() => readVariantDictionary(atCeiling), 'MALFORMED', 'a ceiling-sized value');
    expectVaultError(
      () => readVariantDictionary(overCeiling),
      'TOO_LARGE',
      'an over-ceiling value'
    );
  });
});

describe('refusing a value whose length disagrees with its type', () => {
  it.each([
    ['UInt32', TYPE_UINT32, u64Bytes(1n)],
    ['UInt64', TYPE_UINT64, u32Bytes(1)],
    ['Int32', TYPE_INT32, u64Bytes(1n)],
    ['Int64', TYPE_INT64, u32Bytes(1)],
    ['Bool', TYPE_BOOL, u32Bytes(1)],
  ])('refuses a %s of the wrong width', (name, type, value) => {
    const error = expectVaultError(
      () => readVariantDictionary(buildRaw([{ type, key: 'X', value }])),
      'MALFORMED',
      `a mis-sized ${name}`
    );
    expect(error.message).toContain(name);
  });

  it('refuses a zero-length integer rather than reading it as zero', () => {
    expectVaultError(
      () =>
        readVariantDictionary(
          buildRaw([{ type: TYPE_UINT64, key: 'M', value: new Uint8Array(0) }])
        ),
      'MALFORMED',
      'a zero-length UInt64'
    );
  });
});

describe('refusing text that is not text', () => {
  /** `0xC3 0x28` is the canonical invalid two-byte sequence: a lead byte with a bad tail. */
  const invalidUtf8 = Uint8Array.of(0xc3, 0x28, 0xa0, 0xa1);

  it('refuses an invalid UTF-8 key rather than decoding it to U+FFFD', () => {
    // A lenient decode would turn this into `S�`, which no lookup for `S` would ever
    // match — so the file would be reported as missing its salt rather than as malformed.
    const raw = buildRawWithKeyBytes(TYPE_UINT32, invalidUtf8, u32Bytes(4));
    const error = expectVaultError(
      () => readVariantDictionary(raw),
      'MALFORMED',
      'an invalid UTF-8 key'
    );
    expect(error.message).toContain('not valid UTF-8');
  });

  it('refuses an invalid UTF-8 string value', () => {
    const raw = buildRaw([{ type: TYPE_STRING, key: 'note', value: invalidUtf8 }]);
    expectVaultError(() => readVariantDictionary(raw), 'MALFORMED', 'an invalid UTF-8 value');
  });

  it('refuses an empty key, which nothing could ever look up', () => {
    const raw = buildRawWithKeyBytes(TYPE_UINT32, new Uint8Array(0), u32Bytes(4));
    const error = expectVaultError(() => readVariantDictionary(raw), 'MALFORMED', 'an empty key');
    expect(error.message).toContain('empty name');
  });
});

/** Writes one item with raw key bytes, for names `TextEncoder` cannot express. */
function buildRawWithKeyBytes(type: number, keyBytes: Uint8Array, value: Uint8Array): Uint8Array {
  return concat([
    new ByteWriter().u16(FORMAT_VERSION).u8(type).u32(keyBytes.length).finish(),
    keyBytes,
    new ByteWriter().u32(value.length).finish(),
    value,
    Uint8Array.of(TYPE_END),
  ]);
}

// ── The writer's own refusals ────────────────────────────────────────────────

describe('refusing to write a value it cannot represent', () => {
  const write = (value: VariantValue): (() => Uint8Array) => {
    return () => writeVariantDictionary(new Map([['M', value]]));
  };

  it.each([
    ['a fraction', 1.5],
    ['a NaN', Number.NaN],
    ['an infinity', Number.POSITIVE_INFINITY],
    ['a number above UInt32', 0x1_0000_0000],
    ['a number below Int32', -0x8000_0001],
  ])('refuses %s rather than writing some other integer', (_name, value) => {
    expect(write(value)).toThrow(/Cannot write the KDF parameter/);
  });

  it('refuses a bigint that a DataView would silently wrap', () => {
    // `setBigUint64` reduces modulo 2^64 without complaint. A memory cost that quietly wrapped
    // is the wrong-key-reported-as-wrong-password failure, arriving from the writer instead.
    expect(write(2n ** 64n)).toThrow(/above the range of a 64-bit integer/);
    expect(write(-(2n ** 63n) - 1n)).toThrow(/below the range of a 64-bit integer/);
    // And the boundaries themselves are writable.
    expect(readVariantDictionary(writeVariantDictionary(new Map([['M', 2n ** 64n - 1n]])))).toEqual(
      new Map([['M', 2n ** 64n - 1n]])
    );
  });

  it('refuses an unnamed parameter, which the reader would refuse to read back', () => {
    expect(() => writeVariantDictionary(new Map([['', 1]]))).toThrow(/has no name/);
  });
});

// ── The property that matters most ───────────────────────────────────────────

describe('no refusal ever quotes a value', () => {
  /**
   * Hard rule 1, as a property rather than as a habit.
   *
   * `S` is the Argon2 salt. Errors are logged, screenshotted and pasted into issue trackers,
   * so a message that helpfully included "the salt 03 0a 11 …" would publish it. A message may
   * name the key, the type byte and the offset; nothing else about the item.
   *
   * The check covers hex, base64 and both byte-preserving text encodings, because a value
   * reaches a message through whichever one a careless `String(...)` or `Buffer.toString()`
   * happened to use.
   */
  const salt = Uint8Array.from({ length: 32 }, (_, index) => (index * 11 + 5) & 0xff);
  const secretText = 'correct-horse-battery-staple';
  const secretBytes = encoder.encode(secretText);

  const forbidden = [
    Buffer.from(salt).toString('hex'),
    Buffer.from(salt).toString('hex').slice(0, 16),
    Buffer.from(salt).toString('base64'),
    Buffer.from(salt).toString('latin1'),
    Buffer.from(salt).toString('binary'),
    String(Array.from(salt)),
    secretText,
    secretText.slice(0, 12),
    Buffer.from(secretBytes).toString('hex'),
    Buffer.from(secretBytes).toString('base64'),
  ];

  const items: readonly RawItem[] = [
    {
      type: TYPE_BYTE_ARRAY,
      key: '$UUID',
      value: Uint8Array.from(Buffer.from(KDF_ARGON2D, 'hex')),
    },
    { type: TYPE_BYTE_ARRAY, key: 'S', value: salt },
    { type: TYPE_UINT64, key: 'M', value: u64Bytes(67_108_864n) },
    { type: TYPE_STRING, key: 'Comment', value: secretBytes },
  ];

  const corruptions: readonly (readonly [string, Uint8Array])[] = [
    ['an unsupported version', buildRaw(items, { version: 0x0300 })],
    [
      'an unknown type on the salt',
      buildRaw(items.map((item) => (item.key === 'S' ? { ...item, type: 0x99 } : item))),
    ],
    ['a duplicated salt', buildRaw([...items, items[1]!])],
    [
      'an over-ceiling salt length',
      buildRaw(
        items.map((item) =>
          item.key === 'S' ? { ...item, declaredValueLength: 0xffff_ffff } : item
        )
      ),
    ],
    [
      'an over-ceiling key length',
      buildRaw(
        items.map((item) => (item.key === 'S' ? { ...item, declaredKeyLength: 0xffff_ffff } : item))
      ),
    ],
    ['a truncated salt', buildRaw(items).subarray(0, 30)],
    ['a truncated comment', buildRaw(items).subarray(0, buildRaw(items).length - 6)],
    ['no terminator', buildRaw(items, { terminate: false })],
    ['bytes after the terminator', buildRaw(items, { trailing: salt })],
    [
      'a mis-sized memory cost',
      buildRaw(items.map((item) => (item.key === 'M' ? { ...item, type: TYPE_UINT32 } : item))),
    ],
    [
      'a comment that is not UTF-8',
      buildRaw(
        items.map((item) =>
          item.key === 'Comment' ? { ...item, value: Uint8Array.of(0xc3, 0x28) } : item
        )
      ),
    ],
  ];

  it.each(corruptions)('keeps the salt and the string out of the message for %s', (what, bytes) => {
    let thrown: unknown;
    try {
      readVariantDictionary(bytes);
    } catch (error) {
      thrown = error;
    }

    expect(thrown, `${what} did not throw, so nothing was checked`).toBeInstanceOf(VaultError);
    const message = (thrown as VaultError).message;
    for (const fragment of forbidden) {
      expect(message, `${what} leaked a value into: ${message}`).not.toContain(fragment);
    }
    // The message is still expected to be useful — a refusal with nothing in it would pass
    // the check above trivially.
    expect(message.length).toBeGreaterThan(30);
  });

  it("keeps a rejected value out of the writer's message too", () => {
    // The writer is the half of the module that holds the salt on the way out, so the same
    // rule applies with more force, not less.
    const distinctive = 123_456_789_012;
    let thrown: unknown;
    try {
      writeVariantDictionary(new Map([['M', distinctive]]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain('123456789012');
    expect((thrown as Error).message).toContain('"M"');
  });
});
