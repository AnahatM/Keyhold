// SPDX-License-Identifier: GPL-3.0-or-later
import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInnerStream } from './inner-stream.js';
import { INNER_STREAM_CHACHA20, INNER_STREAM_SALSA20 } from './types.js';

/**
 * The inner random stream is the layer between a decrypted KDBX file and a readable one, and
 * every way of getting it wrong produces the same symptom — plausible-looking garbage where a
 * password should be. There is no tag and no checksum on a protected value, so nothing else in
 * the reader can notice. These tests are the only thing that can.
 *
 * ## Why there is a reference implementation in a test file
 *
 * `createInnerStream` derives its key and nonce by hashing, so a published test vector cannot
 * be fed through the public API — no stream key hashes to RFC 8439's key. Asserting the module
 * against a second `createCipheriv` call would only prove it agrees with itself about a layout
 * both sides guessed.
 *
 * So `referenceKeystream` below is ChaCha20 as RFC 8439 §2.3 writes it, in arithmetic, owing
 * nothing to Node or to the module. It is pinned to **two** published vectors before it is
 * trusted for anything, and only then used to predict what `createInnerStream` must produce.
 * That makes the end-to-end assertion a real known-answer test rather than a tautology.
 *
 * This is a test oracle, not a cipher the product uses. `inner-stream.ts` composes Node's
 * ChaCha20 and nothing else; the rule against inventing cryptography is about what ships.
 */

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const bytes = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));
const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));

// ── RFC 8439 reference ───────────────────────────────────────────────────────

/** RFC 8439 §2.3: the 256-bit key used by every vector below, `00 01 02 … 1f`. */
const RFC_KEY = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));

/** RFC 8439 §2.3.2 — nonce for the block-function vector. */
const RFC_BLOCK_NONCE = bytes('000000090000004a00000000');

/** RFC 8439 §2.3.2 — the serialised ChaCha20 block for that key/nonce at counter 1. */
const RFC_BLOCK_COUNTER_1 =
  '10f1e7e4d13b5915500fdd1fa32071c4' +
  'c7d1f4c733c068030422aa9ac3d46c4e' +
  'd2826446079faa0914c2d705d98b02a2' +
  'b5129cd1de164eb9cbd083e8a2503c4e';

/** RFC 8439 §2.4.2 — nonce for the encryption vector. Note it differs from §2.3.2's. */
const RFC_ENCRYPT_NONCE = bytes('000000000000004a00000000');

/** RFC 8439 §2.4.2 — the plaintext, verbatim including the apostrophes and the colon. */
const RFC_PLAINTEXT = utf8(
  "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the " +
    'future, sunscreen would be it.'
);

/** RFC 8439 §2.4.2 — the expected ciphertext for `RFC_PLAINTEXT` at counter 1. */
const RFC_CIPHERTEXT =
  '6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b' +
  'f91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8' +
  '07ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab7793736' +
  '5af90bbf74a35be6b40b8eedf2785e42874d';

const rotl = (value: number, n: number): number => ((value << n) | (value >>> (32 - n))) >>> 0;

/** One ChaCha20 block, RFC 8439 §2.3. Deliberately transcribed, not optimised. */
function referenceBlock(key: Uint8Array, nonce: Uint8Array, counter: number): Uint8Array {
  const initial = new Uint32Array(16);
  // "expand 32-byte k", as four little-endian words.
  initial[0] = 0x6170_7865;
  initial[1] = 0x3320_646e;
  initial[2] = 0x7962_2d32;
  initial[3] = 0x6b20_6574;

  const keyView = new DataView(key.buffer, key.byteOffset, key.byteLength);
  for (let i = 0; i < 8; i += 1) initial[4 + i] = keyView.getUint32(i * 4, true);

  initial[12] = counter >>> 0;

  const nonceView = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  for (let i = 0; i < 3; i += 1) initial[13 + i] = nonceView.getUint32(i * 4, true);

  const x = Uint32Array.from(initial);
  const quarterRound = (a: number, b: number, c: number, d: number): void => {
    x[a] = ((x[a] ?? 0) + (x[b] ?? 0)) >>> 0;
    x[d] = rotl((x[d] ?? 0) ^ (x[a] ?? 0), 16);
    x[c] = ((x[c] ?? 0) + (x[d] ?? 0)) >>> 0;
    x[b] = rotl((x[b] ?? 0) ^ (x[c] ?? 0), 12);
    x[a] = ((x[a] ?? 0) + (x[b] ?? 0)) >>> 0;
    x[d] = rotl((x[d] ?? 0) ^ (x[a] ?? 0), 8);
    x[c] = ((x[c] ?? 0) + (x[d] ?? 0)) >>> 0;
    x[b] = rotl((x[b] ?? 0) ^ (x[c] ?? 0), 7);
  };

  for (let round = 0; round < 10; round += 1) {
    quarterRound(0, 4, 8, 12);
    quarterRound(1, 5, 9, 13);
    quarterRound(2, 6, 10, 14);
    quarterRound(3, 7, 11, 15);
    quarterRound(0, 5, 10, 15);
    quarterRound(1, 6, 11, 12);
    quarterRound(2, 7, 8, 13);
    quarterRound(3, 4, 9, 14);
  }

  const out = new Uint8Array(64);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 16; i += 1) {
    outView.setUint32(i * 4, ((x[i] ?? 0) + (initial[i] ?? 0)) >>> 0, true);
  }
  return out;
}

/** `length` keystream bytes starting at `counter`, by concatenating reference blocks. */
function referenceKeystream(
  key: Uint8Array,
  nonce: Uint8Array,
  counter: number,
  length: number
): Uint8Array {
  const out = new Uint8Array(Math.ceil(length / 64) * 64);
  for (let block = 0; block * 64 < length; block += 1) {
    out.set(referenceBlock(key, nonce, counter + block), block * 64);
  }
  return out.subarray(0, length);
}

const xor = (a: Uint8Array, b: Uint8Array): Uint8Array =>
  Uint8Array.from(a, (byte, i) => byte ^ (b[i] ?? 0));

// ── The stream key used by the end-to-end tests ──────────────────────────────

/**
 * KeePass writes 64 bytes here. A fixed value rather than a random one, so that a failure is
 * the same failure every run — this is a known-answer test and a flaky one would be worthless.
 */
const STREAM_KEY = new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff));

/** What `inner-stream.ts` must derive: SHA-512, key `h[0..32)`, nonce `h[32..44)`, counter 0. */
function expectedKeystream(streamKey: Uint8Array, length: number): Uint8Array {
  const h = new Uint8Array(createHash('sha512').update(streamKey).digest());
  return referenceKeystream(h.subarray(0, 32), h.subarray(32, 44), 0, length);
}

describe('the RFC 8439 reference used to check the module', () => {
  it('reproduces the §2.3.2 block-function vector', () => {
    expect(hex(referenceBlock(RFC_KEY, RFC_BLOCK_NONCE, 1))).toBe(RFC_BLOCK_COUNTER_1);
  });

  it('reproduces the §2.4.2 encryption vector', () => {
    const keystream = referenceKeystream(RFC_KEY, RFC_ENCRYPT_NONCE, 1, RFC_PLAINTEXT.length);
    expect(hex(xor(RFC_PLAINTEXT, keystream))).toBe(RFC_CIPHERTEXT);
  });

  it('places counter 1 exactly one 64-byte block after counter 0', () => {
    // The off-by-one-block bug in miniature: if the leading IV word were anything but a block
    // counter, these two would not line up, and nothing would go wrong until the 65th byte.
    const fromZero = referenceKeystream(RFC_KEY, RFC_ENCRYPT_NONCE, 0, 64 + 114);
    const fromOne = referenceKeystream(RFC_KEY, RFC_ENCRYPT_NONCE, 1, 114);
    expect(hex(fromZero.subarray(64))).toBe(hex(fromOne));
  });
});

describe("Node's chacha20 IV layout", () => {
  /**
   * `inner-stream.ts` is built on the claim that Node wants a 16-byte IV of `counter-LE ||
   * nonce`. That claim is about somebody else's library and could change under an upgrade
   * without a line of this repo moving, so it is asserted rather than remembered. If this file
   * ever goes red on a Node bump, `inner-stream.ts` is the thing to re-derive.
   */
  const nodeChaCha = (iv: Uint8Array): string => {
    const cipher = createCipheriv('chacha20', RFC_KEY, iv);
    return hex(new Uint8Array(Buffer.concat([cipher.update(RFC_PLAINTEXT), cipher.final()])));
  };

  const withCounter = (counter: string): Uint8Array =>
    new Uint8Array([...bytes(counter), ...RFC_ENCRYPT_NONCE]);

  it('reproduces RFC 8439 §2.4.2 from a 4-byte little-endian counter followed by the nonce', () => {
    expect(nodeChaCha(withCounter('01000000'))).toBe(RFC_CIPHERTEXT);
  });

  it('does not accept the bare 12-byte nonce, so that mistake cannot be silent', () => {
    expect(() => nodeChaCha(RFC_ENCRYPT_NONCE)).toThrow(/initialization vector/i);
  });

  it('reads the leading word little-endian, not big-endian', () => {
    expect(nodeChaCha(withCounter('00000001'))).not.toBe(RFC_CIPHERTEXT);
  });

  it('puts the counter before the nonce, not after it', () => {
    const reversed = new Uint8Array([...RFC_ENCRYPT_NONCE, ...bytes('01000000')]);
    expect(nodeChaCha(reversed)).not.toBe(RFC_CIPHERTEXT);
  });

  it('treats the leading word as a 64-byte block counter, which is what fixes counter 0', () => {
    // Counter 0 then discard exactly one block must land where counter 1 begins. This is the
    // property `inner-stream.ts` relies on when it starts at 0 and never touches the counter
    // again — and the one whose failure mode is invisible until the 65th byte.
    const cipher = createCipheriv('chacha20', RFC_KEY, withCounter('00000000'));
    const stream = new Uint8Array(
      Buffer.concat([cipher.update(new Uint8Array(64 + RFC_PLAINTEXT.length)), cipher.final()])
    );
    expect(hex(xor(RFC_PLAINTEXT, stream.subarray(64)))).toBe(RFC_CIPHERTEXT);
  });
});

describe('createInnerStream — ChaCha20', () => {
  it('matches the RFC 8439 keystream for the key and nonce KDBX derives', () => {
    // The known-answer test. It fails if the SHA-512 halves are swapped, if the nonce is taken
    // from the wrong offset, if the counter does not start at 0, or if Node's IV is assembled
    // in the wrong order — none of which the module could notice on its own.
    const length = 200; // Four blocks and a bit, so a block boundary is crossed twice.
    const stream = createInnerStream(INNER_STREAM_CHACHA20, STREAM_KEY);

    expect(hex(stream.process(new Uint8Array(length)))).toBe(
      hex(expectedKeystream(STREAM_KEY, length))
    );
  });

  it('continues the keystream across calls instead of restarting it', () => {
    const first = utf8('correct horse');
    const second = utf8('battery staple');

    const split = createInnerStream(INNER_STREAM_CHACHA20, STREAM_KEY);
    const a = split.process(first);
    const b = split.process(second);

    const whole = createInnerStream(INNER_STREAM_CHACHA20, STREAM_KEY);
    const together = whole.process(new Uint8Array([...first, ...second]));

    expect(hex(new Uint8Array([...a, ...b]))).toBe(hex(together));
  });

  it('stays continuous across a call that straddles the 64-byte block boundary', () => {
    // The sharper version of the test above: two values whose split lands mid-block. A
    // per-call cipher passes nothing here, but so would a correct-looking implementation that
    // only ever re-keyed on block boundaries.
    const head = new Uint8Array(60).fill(0xaa);
    const straddling = new Uint8Array(90).fill(0x55);

    const split = createInnerStream(INNER_STREAM_CHACHA20, STREAM_KEY);
    const a = split.process(head);
    const b = split.process(straddling);

    const expected = xor(
      new Uint8Array([...head, ...straddling]),
      expectedKeystream(STREAM_KEY, 150)
    );

    expect(hex(new Uint8Array([...a, ...b]))).toBe(hex(expected));
    // And the straddling half specifically, so a failure names which side moved.
    expect(hex(b)).toBe(hex(expected.subarray(60)));
  });

  it('round-trips a document of values through two streams of the same key', () => {
    const values = ['hunter2', '', 'a much longer passphrase than the first one, by some way', 'x'];

    const writer = createInnerStream(INNER_STREAM_CHACHA20, STREAM_KEY);
    const protectedValues = values.map((value) => writer.process(utf8(value)));

    const reader = createInnerStream(INNER_STREAM_CHACHA20, STREAM_KEY);
    const recovered = protectedValues.map((value) => Buffer.from(reader.process(value)).toString());

    expect(recovered).toEqual(values);
    // The empty value in the middle must not have consumed a keystream byte, or everything
    // after it would be off by one.
    expect(protectedValues[1]).toHaveLength(0);
  });

  it('is not a no-op — the ciphertext genuinely differs from the plaintext', () => {
    // Cheap, but it is the one thing a round-trip test cannot tell you: XOR against an
    // all-zero keystream round-trips perfectly too.
    const plaintext = utf8('a value that must not survive unchanged');
    const stream = createInnerStream(INNER_STREAM_CHACHA20, STREAM_KEY);
    expect(hex(stream.process(plaintext))).not.toBe(hex(plaintext));
  });

  it('does not modify the caller’s buffer', () => {
    const plaintext = utf8('hunter2');
    const before = hex(plaintext);
    createInnerStream(INNER_STREAM_CHACHA20, STREAM_KEY).process(plaintext);
    expect(hex(plaintext)).toBe(before);
  });

  it('produces a different keystream for a different stream key', () => {
    const other = Uint8Array.from(STREAM_KEY);
    other[0] = (other[0] ?? 0) ^ 0b0000_0001;

    const a = createInnerStream(INNER_STREAM_CHACHA20, STREAM_KEY).process(new Uint8Array(64));
    const b = createInnerStream(INNER_STREAM_CHACHA20, other).process(new Uint8Array(64));

    expect(hex(a)).not.toBe(hex(b));
  });
});

describe('createInnerStream — refusals', () => {
  it('refuses Salsa20 by name, and says how to fix it', () => {
    expect(() => createInnerStream(INNER_STREAM_SALSA20, STREAM_KEY)).toThrow(/Salsa20/);
    expect(() => createInnerStream(INNER_STREAM_SALSA20, STREAM_KEY)).toThrow(/KDBX 3/);
    expect(() => createInnerStream(INNER_STREAM_SALSA20, STREAM_KEY)).toThrow(/KeePassXC/);
    expect(() => createInnerStream(INNER_STREAM_SALSA20, STREAM_KEY)).toThrow(/KDBX 4/);
  });

  it('refuses an unknown stream id', () => {
    for (const id of [0, 1, 4, 255, 0xffff_ffff]) {
      expect(() => createInnerStream(id, STREAM_KEY)).toThrow(/does not define/);
    }
  });

  it('refuses an absent stream key rather than using a publicly derivable keystream', () => {
    expect(() => createInnerStream(INNER_STREAM_CHACHA20, new Uint8Array(0))).toThrow(
      /no stream key/
    );
  });

  it('never puts the stream key in a refusal message', () => {
    // Hard rule 1. The check is against every representation the key could plausibly leak as,
    // not just the one a careless template literal would produce.
    const representations = [
      hex(STREAM_KEY),
      Buffer.from(STREAM_KEY).toString('base64'),
      STREAM_KEY.join(','),
      String(STREAM_KEY),
      hex(STREAM_KEY.subarray(0, 8)),
    ];

    const messages: string[] = [];
    for (const id of [INNER_STREAM_SALSA20, 0, 7]) {
      try {
        createInnerStream(id, STREAM_KEY);
      } catch (error) {
        messages.push(error instanceof Error ? `${error.message} ${error.stack ?? ''}` : '');
      }
    }

    expect(messages).toHaveLength(3);
    for (const message of messages) {
      for (const representation of representations) {
        expect(message).not.toContain(representation);
      }
    }
  });
});
