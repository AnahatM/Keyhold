// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  MAGIC,
  MAGIC_LENGTH,
  MAX_BODY_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
} from '@shared/format/types.js';
import { inspectVaultFile } from './file-inspection.js';
import {
  HEADER_LENGTH_OFFSET,
  HEADER_OFFSET,
  VERSION_OFFSET,
  bodyLengthOf,
  bodyLengthOffsetOf,
  bodyOffsetOf,
  buildContainer,
  chunkCountOffsetOf,
  chunkId,
  headerLengthOf,
  overwrittenAt,
  truncatedTo,
  withTrailing,
  withUint16At,
  withUint32At,
} from './test-support.js';

/**
 * The contract this file exists to hold is a promise about *usefulness*, not just about not
 * crashing: a user whose vault will not open must be told where it stops being readable, in
 * bytes, and what that most likely means. So most assertions here are about `stoppedAt` —
 * the stage, the offset, and the numbers in the sentence — rather than merely about a
 * boolean.
 *
 * Every damaged fixture is a real container with specific bytes removed or overwritten. See
 * `test-support.ts` for why that matters.
 */

const sealedMinimum = NONCE_BYTES + TAG_BYTES;

describe('a container that is not damaged', () => {
  it('walks to the end and says so, without promising it will decrypt', () => {
    const inspection = inspectVaultFile(buildContainer());

    expect(inspection.structurallyIntact).toBe(true);
    expect(inspection.stoppedAt).toBeNull();
    expect(inspection.reachedStage).toBe('complete');
    expect(inspection.issues).toEqual([]);
    // The honesty requirement: a green result must not be read as "this will open".
    expect(inspection.verdict).toContain('not a promise');
  });

  it('reports the header as sizes, never as key material', () => {
    const inspection = inspectVaultFile(buildContainer());
    const header = inspection.header;

    expect(header?.generation).toBe(214);
    expect(header?.kdf.saltBytes).toBe(16);
    expect(header?.wrappedDekBytes).toEqual({ nonce: 12, ciphertext: 32, tag: 16 });
    // The salt and the wrapped key are reported as lengths and must not appear as values.
    expect(JSON.stringify(inspection)).not.toContain('salt"');
    expect(Object.keys(header?.kdf ?? {})).not.toContain('salt');
  });

  it('frames every attachment chunk it was given', () => {
    const bytes = buildContainer({
      attachments: [
        { id: chunkId('a'), data: Uint8Array.from([1, 2, 3]) },
        { id: chunkId('b'), data: Uint8Array.from([4, 5]) },
      ],
    });
    const inspection = inspectVaultFile(bytes);

    expect(inspection.structurallyIntact).toBe(true);
    expect(inspection.chunks.map((chunk) => chunk.id)).toEqual([chunkId('a'), chunkId('b')]);
    expect(inspection.chunks.every((chunk) => chunk.present)).toBe(true);
  });

  it('reports a layout whose offsets match where the fields really are', () => {
    const bytes = buildContainer();
    const layout = inspectVaultFile(bytes).layout;

    // Cross-checked against the bytes rather than against a restated constant, so a layout
    // that drifted from the writer's would fail here rather than agree with itself.
    expect(layout?.headerOffset).toBe(HEADER_OFFSET);
    expect(layout?.headerLength).toBe(headerLengthOf(bytes));
    expect(layout?.bodyLengthOffset).toBe(bodyLengthOffsetOf(bytes));
    expect(layout?.bodyOffset).toBe(bodyOffsetOf(bytes));
    expect(layout?.declaredBodyLength).toBe(bodyLengthOf(bytes));
    expect(layout?.trailingBytes).toBe(0);
  });
});

describe('where the file stops being readable', () => {
  it('names an empty file as empty rather than as "not a vault"', () => {
    const inspection = inspectVaultFile(new Uint8Array(0));

    expect(inspection.reachedStage).toBeNull();
    expect(inspection.stoppedAt?.stage).toBe('magic');
    expect(inspection.stoppedAt?.availableBytes).toBe(0);
    expect(inspection.issues.map((issue) => issue.code)).toEqual(['file-empty']);
  });

  it('separates a zero-filled head from a wrong file, because they mean different things', () => {
    const zeroed = overwrittenAt(buildContainer(), 0, new Uint8Array(MAGIC_LENGTH));
    const inspection = inspectVaultFile(zeroed);

    expect(inspection.issues.map((issue) => issue.code)).toEqual(['not-a-vault']);
    // A sparse file / failed sync leaves this, and the sentence has to say so, because the
    // remedy (find another copy) differs from "you picked the wrong file".
    expect(inspection.stoppedAt?.meaning).toContain('sparse');
  });

  it('calls a JPEG not a vault, at byte 0', () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
    const inspection = inspectVaultFile(jpeg);

    expect(inspection.stoppedAt?.offset).toBe(0);
    expect(inspection.issues.map((issue) => issue.code)).toEqual(['not-a-vault']);
  });

  it('stops inside the signature when there is not even one', () => {
    const inspection = inspectVaultFile(MAGIC.slice(0, 3));

    expect(inspection.stoppedAt?.stage).toBe('magic');
    expect(inspection.stoppedAt?.expectedBytes).toBe(MAGIC_LENGTH);
    expect(inspection.stoppedAt?.availableBytes).toBe(3);
    expect(inspection.issues.map((issue) => issue.code)).toEqual(['file-too-short']);
  });

  it('refuses to guess at a newer format rather than reporting a false truncation', () => {
    const future = withUint16At(buildContainer(), VERSION_OFFSET, 99);
    const inspection = inspectVaultFile(future);

    expect(inspection.reachedStage).toBe('magic');
    expect(inspection.stoppedAt?.stage).toBe('format-version');
    expect(inspection.issues.map((issue) => issue.code)).toEqual(['unsupported-version']);
    // The critical half: it must not send someone to restore a backup over a good file.
    expect(inspection.stoppedAt?.meaning).toContain('has not been modified');
  });

  it('rejects a version below 1 as overwritten bytes', () => {
    const zeroVersion = withUint16At(buildContainer(), VERSION_OFFSET, 0);
    const inspection = inspectVaultFile(zeroVersion);

    expect(inspection.issues.map((issue) => issue.code)).toEqual(['invalid-version']);
    expect(inspection.stoppedAt?.stage).toBe('format-version');
  });

  it('stops at the header when the file ends inside it, and says how short it is', () => {
    const bytes = buildContainer();
    const headerLength = headerLengthOf(bytes);
    const cut = truncatedTo(bytes, HEADER_OFFSET + 10);
    const inspection = inspectVaultFile(cut);

    expect(inspection.reachedStage).toBe('header-length');
    expect(inspection.stoppedAt?.stage).toBe('header-bytes');
    expect(inspection.stoppedAt?.offset).toBe(HEADER_OFFSET);
    expect(inspection.stoppedAt?.expectedBytes).toBe(headerLength);
    expect(inspection.stoppedAt?.availableBytes).toBe(10);
    expect(inspection.issues.map((issue) => issue.code)).toEqual(['header-truncated']);
  });

  it('reports a header that is present but will not parse as unrecoverable, not as truncated', () => {
    const bytes = buildContainer();
    // Same length, different content: the bytes are all there and are simply not a header.
    const rubbish = overwrittenAt(bytes, HEADER_OFFSET, new Uint8Array(20).fill(0x7b));
    const inspection = inspectVaultFile(rubbish);

    expect(inspection.reachedStage).toBe('header-bytes');
    expect(inspection.stoppedAt?.stage).toBe('header-json');
    expect(inspection.issues.map((issue) => issue.code)).toEqual(['header-unreadable']);
    expect(inspection.header).toBeNull();
    // The user needs to know a correct password will not help.
    expect(inspection.stoppedAt?.meaning).toContain('cannot be unlocked');
  });

  it('stops before the body when the write ended right after the header', () => {
    const bytes = buildContainer();
    const cut = truncatedTo(bytes, bodyLengthOffsetOf(bytes) + 2);
    const inspection = inspectVaultFile(cut);

    expect(inspection.reachedStage).toBe('header-json');
    expect(inspection.stoppedAt?.stage).toBe('body-length');
    expect(inspection.issues.map((issue) => issue.code)).toEqual(['body-truncated']);
    // The header parsed, so its facts are still reportable — that is the useful part.
    expect(inspection.header?.generation).toBe(214);
  });

  it('is the headline case: header intact, body truncated, with the byte count', () => {
    const bytes = buildContainer({ body: randomBytes(4096) });
    const declared = bodyLengthOf(bytes);
    const missing = 500;
    const cut = truncatedTo(bytes, bodyOffsetOf(bytes) + declared - missing);

    const inspection = inspectVaultFile(cut);

    expect(inspection.reachedStage).toBe('body-length');
    expect(inspection.stoppedAt?.stage).toBe('body-bytes');
    expect(inspection.stoppedAt?.offset).toBe(bodyOffsetOf(bytes));
    expect(inspection.stoppedAt?.expectedBytes).toBe(declared);
    expect(inspection.stoppedAt?.availableBytes).toBe(declared - missing);
    expect(inspection.issues.map((issue) => issue.code)).toEqual(['body-truncated']);

    // The sentence must carry the numbers and must not imply a salvage.
    expect(inspection.stoppedAt?.meaning).toContain('500 bytes early');
    expect(inspection.stoppedAt?.meaning).toContain('whole or not at all');
    // The header survived, so it is still reported — this is the difference between
    // "could not open file" and a user who knows to go and find a backup.
    expect(inspection.header).not.toBeNull();
  });

  it('calls out a body length above the ceiling instead of trying to read it', () => {
    const bytes = buildContainer();
    const absurd = withUint32At(bytes, bodyLengthOffsetOf(bytes), MAX_BODY_BYTES + 1);
    const inspection = inspectVaultFile(absurd);

    expect(inspection.stoppedAt?.stage).toBe('body-length');
    expect(inspection.issues.map((issue) => issue.code)).toEqual(['body-length-implausible']);
  });

  it('calls out a body length below the smallest sealed region there can be', () => {
    const bytes = buildContainer();
    const tiny = withUint32At(bytes, bodyLengthOffsetOf(bytes), sealedMinimum - 1);
    const inspection = inspectVaultFile(tiny);

    expect(inspection.issues.map((issue) => issue.code)).toEqual(['body-length-implausible']);
    expect(inspection.stoppedAt?.meaning).toContain('corrupt');
  });

  it('says the records are probably fine when only the attachment count is missing', () => {
    const bytes = buildContainer();
    const cut = truncatedTo(bytes, chunkCountOffsetOf(bytes) + 1);
    const inspection = inspectVaultFile(cut);

    expect(inspection.reachedStage).toBe('body-bytes');
    expect(inspection.stoppedAt?.stage).toBe('chunk-count');
    expect(inspection.issues.map((issue) => issue.code)).toEqual(['chunk-count-truncated']);
    expect(inspection.stoppedAt?.meaning).toContain('records');
  });

  it('refuses an attachment count that could not fit in the bytes that remain', () => {
    const bytes = buildContainer();
    const lying = withUint32At(bytes, chunkCountOffsetOf(bytes), 100_000);
    const inspection = inspectVaultFile(lying);

    expect(inspection.stoppedAt?.stage).toBe('chunk-count');
    expect(inspection.issues.map((issue) => issue.code)).toEqual(['chunk-framing-broken']);
  });

  it('reports which attachment the tail was cut inside, and that earlier ones survived', () => {
    const bytes = buildContainer({
      attachments: [
        { id: chunkId('a'), data: new Uint8Array(64).fill(1) },
        { id: chunkId('b'), data: new Uint8Array(64).fill(2) },
      ],
    });
    const cut = truncatedTo(bytes, bytes.length - 20);
    const inspection = inspectVaultFile(cut);

    expect(inspection.stoppedAt?.stage).toBe('chunk-framing');
    expect(inspection.issues.map((issue) => issue.code)).toEqual(['chunk-framing-broken']);
    // The first chunk framed cleanly; only the second is short.
    expect(inspection.chunks[0]?.present).toBe(true);
    expect(inspection.chunks[1]?.present).toBe(false);
    expect(inspection.stoppedAt?.meaning).toContain('unaffected');
  });
});

describe('findings that do not stop the walk', () => {
  it('notices the preamble and the header disagreeing about the version', () => {
    // Version 1 in the header, 2 in the preamble: the preamble was edited after the write.
    // Stored twice precisely so this is detectable — and the walk continues, because the
    // rest of the layout is still worth reporting.
    const bytes = withUint16At(buildContainer(), VERSION_OFFSET, 1);
    const header = Buffer.from(bytes).indexOf('"formatVersion":1');
    expect(header).toBeGreaterThan(0);

    const edited = overwrittenAt(
      bytes,
      header,
      new Uint8Array(Buffer.from('"formatVersion":2', 'utf8'))
    );
    const inspection = inspectVaultFile(edited);

    expect(inspection.issues.map((issue) => issue.code)).toContain('version-disagreement');
    expect(inspection.reachedStage).toBe('complete');
    expect(inspection.structurallyIntact).toBe(true);
  });

  it('flags KDF parameters outside the accepted range without halting', () => {
    const weak = buildContainer({
      header: {
        kdf: { alg: 'argon2id', memoryKib: 8, iterations: 1, parallelism: 1, salt: 'AAAA' },
      },
    });
    const inspection = inspectVaultFile(weak);

    expect(inspection.issues.map((issue) => issue.code)).toContain('kdf-out-of-range');
    expect(inspection.reachedStage).toBe('complete');
  });

  it('notices the header claiming more attachments than the file holds', () => {
    const bytes = buildContainer({
      header: { attachmentCount: 4 },
      attachments: [{ id: chunkId('c'), data: Uint8Array.from([9]) }],
    });
    const inspection = inspectVaultFile(bytes);

    expect(inspection.issues.map((issue) => issue.code)).toContain('chunk-count-disagreement');
    // Structurally the file is fine; something has quietly vanished, which is the point.
    expect(inspection.structurallyIntact).toBe(true);
  });

  it('reports bytes after the end of the container', () => {
    const inspection = inspectVaultFile(withTrailing(buildContainer(), 64));

    expect(inspection.issues.map((issue) => issue.code)).toEqual(['trailing-bytes']);
    expect(inspection.structurallyIntact).toBe(true);
    expect(inspection.verdict).toContain('need attention');
  });
});

describe('arbitrary bytes', () => {
  it('returns a value for every prefix of a real container, and never throws', () => {
    const bytes = buildContainer({
      attachments: [{ id: chunkId('d'), data: new Uint8Array(40).fill(3) }],
    });

    // Every truncation point, exhaustively. A parser handed a short file must return an
    // observation, not an exception — a diagnostics screen that throws while explaining a
    // broken file is the one failure this module cannot have.
    for (let length = 0; length <= bytes.length; length += 1) {
      const inspection = inspectVaultFile(truncatedTo(bytes, length));
      expect(inspection.sizeBytes).toBe(length);
      expect(typeof inspection.verdict).toBe('string');
      expect(inspection.verdict.length).toBeGreaterThan(0);
      // A stop and structural soundness are exactly complementary.
      expect(inspection.structurallyIntact).toBe(inspection.stoppedAt === null);
    }
  });

  it('never throws on random bytes, whatever length they are', () => {
    for (const length of [1, 7, 8, 9, 13, 14, 15, 64, 512, 4096]) {
      const noise = new Uint8Array(randomBytes(length));
      expect(() => inspectVaultFile(noise)).not.toThrow();
      expect(inspectVaultFile(noise).sizeBytes).toBe(length);
    }
  });

  it('never throws when the signature is right but everything after it is noise', () => {
    // The nastier case: the walk gets past the gate and then reads garbage lengths.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const tail = new Uint8Array(randomBytes(96));
      const bytes = new Uint8Array(MAGIC_LENGTH + tail.length);
      bytes.set(MAGIC, 0);
      bytes.set(tail, MAGIC_LENGTH);

      const inspection = inspectVaultFile(bytes);
      expect(inspection.structurallyIntact).toBe(false);
      expect(inspection.issues.length).toBeGreaterThan(0);
    }
  });

  it('does not repeat file content in an issue detail', () => {
    // A header full of a recognisable marker. `parseHeader`'s message is borrowed into the
    // detail, so the marker must not ride along with it.
    //
    // Worth knowing what this one does and does not prove: `{"x":"…"}` has no `cipher` field,
    // so it is rejected by `requireString` — a message that quotes only the field-name
    // literal `"cipher"` and never had the marker anywhere near it. It is a real assertion
    // about the *first* rejection path and it passed vacuously as a statement about the
    // others. The block below reaches the two that actually interpolated.
    const marker = 'MARKERMARKERMARKER';
    const bytes = buildContainer();
    const poisoned = overwrittenAt(
      bytes,
      HEADER_OFFSET,
      new Uint8Array(Buffer.from(`{"x":"${marker}"}`, 'utf8'))
    );

    const inspection = inspectVaultFile(poisoned);
    expect(JSON.stringify(inspection)).not.toContain(marker);
  });

  it('is not thrown off by a header length field larger than the whole file', () => {
    const bytes = buildContainer();
    const absurd = withUint32At(bytes, HEADER_LENGTH_OFFSET, 0xffff_ffff);
    const inspection = inspectVaultFile(absurd);

    expect(inspection.stoppedAt?.stage).toBe('header-bytes');
    expect(inspection.issues.map((issue) => issue.code)).toEqual(['header-truncated']);
  });

  it('is a pure function of the bytes — two calls agree exactly', () => {
    const bytes = truncatedTo(buildContainer({ body: randomBytes(2048) }), 900);
    expect(inspectVaultFile(bytes)).toEqual(inspectVaultFile(bytes));
  });

  it('does not mutate the bytes it was handed', () => {
    const bytes = buildContainer();
    const before = Uint8Array.from(bytes);
    inspectVaultFile(bytes);
    expect(bytes).toEqual(before);
  });
});

/**
 * The header's own message, as it arrives in a report.
 *
 * `parseHeader`'s message is borrowed verbatim through `sanitiseDetail`, and the report exists
 * to be pasted into an issue tracker. Two of its messages used to interpolate a string read
 * straight out of the header — the `kdf.alg` and `cipher` fields — with a 200-character cap as
 * the only thing behind them. A cap bounds how much a crafted file gets to say; it says nothing
 * about what.
 *
 * These fixtures are the adversarial half: a claimed algorithm carrying a quote, one carrying
 * newlines, and one 300 characters long. `header.test.ts` asserts on the message directly;
 * these assert on the whole `VaultFileInspection`, because the borrowing is what makes the
 * message a *report* problem rather than a dialog one.
 */
describe('a header claiming a hostile algorithm name', () => {
  /**
   * A real container whose header JSON has been rewritten.
   *
   * Built from `buildContainer` rather than by hand, then re-framed: the header length field is
   * rewritten to match, and everything after the original header is kept. Inspection halts at
   * `header-json` long before any of it is read, which is exactly the path under test.
   */
  const withHeaderJson = (mutate: (header: Record<string, unknown>) => void): Uint8Array => {
    const bytes = buildContainer();
    const length = headerLengthOf(bytes);
    const original = Buffer.from(bytes).subarray(HEADER_OFFSET, HEADER_OFFSET + length);
    const header = JSON.parse(original.toString('utf8')) as Record<string, unknown>;
    mutate(header);

    const replacement = Buffer.from(JSON.stringify(header), 'utf8');
    const lengthField = Buffer.alloc(4);
    lengthField.writeUInt32LE(replacement.length, 0);

    return new Uint8Array(
      Buffer.concat([
        Buffer.from(bytes).subarray(0, HEADER_LENGTH_OFFSET),
        lengthField,
        replacement,
        Buffer.from(bytes).subarray(HEADER_OFFSET + length),
      ])
    );
  };

  const detailFor = (bytes: Uint8Array): string => {
    const inspection = inspectVaultFile(bytes);
    expect(inspection.reachedStage).toBe('header-bytes');
    expect(inspection.stoppedAt?.stage).toBe('header-json');
    expect(inspection.issues.map((issue) => issue.code)).toEqual(['header-unreadable']);
    return inspection.issues[0]?.detail ?? '';
  };

  const HOSTILE: readonly (readonly [name: string, claimed: string])[] = [
    ['a quote of its own', 'argon2id" and definitely "unlocked'],
    ['newlines that forge a second finding', 'argon2id\n\nCRITICAL: vault seized\n'],
    ['300 characters of junk', 'Z'.repeat(300)],
    ['an ANSI escape', '\u001b[31margon2id\u001b[0m'],
    ['a NUL byte', 'argon2id\u0000injected'],
  ];

  it('never reproduces the claimed key-derivation algorithm', () => {
    for (const [what, claimed] of HOSTILE) {
      const bytes = withHeaderJson((header) => {
        header.kdf = { ...(header.kdf as Record<string, unknown>), alg: claimed };
      });

      const detail = detailFor(bytes);
      expect(detail, what).toContain('does not recognise');
      expect(detail, what).not.toContain(claimed);
      expect(JSON.stringify(inspectVaultFile(bytes)), what).not.toContain(claimed);
    }
  });

  it('never reproduces the claimed cipher', () => {
    for (const [what, claimed] of HOSTILE) {
      const bytes = withHeaderJson((header) => {
        header.cipher = claimed;
      });

      const detail = detailFor(bytes);
      expect(detail, what).toContain('does not recognise');
      expect(detail, what).not.toContain(claimed);
      expect(JSON.stringify(inspectVaultFile(bytes)), what).not.toContain(claimed);
    }
  });

  it('is short because the message was composed, not because it was truncated', () => {
    // The distinction the old cap could not make. `sanitiseDetail` still runs and still ends a
    // long borrowed message with an ellipsis; a detail that needs it is a detail that carried
    // 200 characters of somebody else's choosing up to that point.
    const bytes = withHeaderJson((header) => {
      header.cipher = 'Q'.repeat(4096);
    });
    const detail = detailFor(bytes);

    expect(detail).not.toContain('…');
    expect(detail.length).toBeLessThan(200);
    expect(detail).toContain('4096 character(s)');
  });

  it('still names an algorithm that is on the allow-list, because that is the useful case', () => {
    // The cost of the fix, stated as a test: a recognised name is still reported by name, so a
    // user holding a file from another manager is told which one rather than being told
    // nothing. Only unrecognised names lose their spelling.
    const bytes = withHeaderJson((header) => {
      header.cipher = 'ChaCha20-Poly1305';
    });

    expect(detailFor(bytes)).toContain('"ChaCha20-Poly1305"');
  });

  it('reports the same finding whatever the claimed name is', () => {
    // A crafted file must not be able to change *which* problem the report describes, only
    // whether its own name appears in it.
    const codes = HOSTILE.map(([, claimed]) => {
      const bytes = withHeaderJson((header) => {
        header.cipher = claimed;
      });
      return inspectVaultFile(bytes)
        .issues.map((issue) => issue.code)
        .join(',');
    });

    expect(new Set(codes).size).toBe(1);
  });
});

describe('the numbers a report will quote', () => {
  it('groups digits without depending on the machine locale', () => {
    const bytes = buildContainer({ body: randomBytes(4096) });
    const cut = truncatedTo(bytes, bodyOffsetOf(bytes) + 100);
    const meaning = inspectVaultFile(cut).stoppedAt?.meaning ?? '';

    // A German machine's `toLocaleString` would render `4.096` here and the report would
    // read differently in CI than on a laptop. `formatCount` is deliberately not localised.
    expect(meaning).toMatch(/\d,\d{3}/);
    expect(meaning).not.toMatch(/\d\.\d{3}/);
  });

  it('reports a stop offset that is a real index into the file', () => {
    const bytes = buildContainer();
    for (const length of [0, 5, 9, 13, HEADER_OFFSET + 4, bodyOffsetOf(bytes) + 1]) {
      const stop = inspectVaultFile(truncatedTo(bytes, length)).stoppedAt;
      if (stop === null) continue;
      expect(stop.offset).toBeGreaterThanOrEqual(0);
      expect(stop.offset).toBeLessThanOrEqual(length);
      expect(stop.availableBytes).toBeGreaterThanOrEqual(0);
    }
  });
});
