// SPDX-License-Identifier: GPL-3.0-or-later
import { SecretBytes } from '../crypto/secret.js';
import { invalidSeed } from './errors.js';

/**
 * RFC 4648 base32, as one-time-password seeds are actually written in the world.
 *
 * The specification is half a page. The hard part is everything around it: a seed reaches
 * this function from an `otpauth://` URI, from a CSV column another manager wrote, from a
 * QR code, or from a human retyping what a website printed on an enrolment page — and those
 * four sources disagree about case, whitespace, grouping and padding.
 *
 * ## What is accepted, and why
 *
 * | Input                    | Why it is accepted                                             |
 * | ------------------------ | -------------------------------------------------------------- |
 * | `jbswy3dpehpk3pxp`       | Lower case. RFC 4648 §3.4 says decoders may accept either case. |
 * | `JBSW Y3DP EHPK 3PXP`    | Google, GitHub and Microsoft all print seeds in groups of four. |
 * | `JBSW-Y3DP-EHPK-3PXP`    | Some enrolment pages hyphenate instead of spacing.              |
 * | a non-breaking space     | What a browser copy from a styled `<code>` block actually puts on the clipboard. |
 * | `JBSWY3DPEHPK3PXP`       | Unpadded. The overwhelmingly common form; `=` is rarely emitted. |
 * | `MFRGG===`               | Padded. What a strict RFC 4648 encoder emits.                   |
 *
 * ## What is rejected, and why rejection is the right answer
 *
 * Everything else — `0`, `1`, `8`, `9`, punctuation, a `=` that is not trailing, a character
 * count that no encoder could have produced, and trailing bits that are not zero.
 *
 * The temptation with a seed is to be forgiving: map `0`→`O`, `1`→`L` (both of which *are*
 * in the alphabet, which is what makes the confusion so easy to make and so damaging to
 * "fix"), drop what does not fit, decode what is left. **That is the worst thing this
 * function could do**, because the repair succeeds and yields a valid key that is not the
 * user's key — see the `0/O` case in `base32.test.ts`, which proves it. A seed that
 * decodes to the wrong bytes does not fail — it produces six digits, in the right format, at
 * the right moment, that the service rejects. The user then has a working-looking
 * authenticator that never lets them in, and no way to tell whether the fault is the seed,
 * the clock, or the service. An error naming the problem is recoverable in seconds; a
 * silently wrong key is a support ticket that ends in "just re-enrol everything".
 *
 * The non-canonical trailing-bits check is the same argument. RFC 4648 §3.5 permits a
 * decoder to reject a final character whose unused bits are not zero, and here it is worth
 * doing: no conforming encoder produces one, so its presence means the string was truncated,
 * retyped wrong, or had a character transposed — and the bytes that come out would be a
 * plausible-looking key that is not the user's key.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const CODE_A = 0x41;
const CODE_Z = 0x5a;
const LOWERCASE_OFFSET = 0x20;
const BITS_PER_CHARACTER = 5;
const BITS_PER_BYTE = 8;

/**
 * Character code → 5-bit value, or -1 for "not in the alphabet".
 *
 * A table rather than `ALPHABET.indexOf` per character: `indexOf` is a scan, and case
 * folding first would allocate a second copy of the seed — a copy of secret material that
 * nothing would then be responsible for clearing.
 */
const VALUES = buildValueTable();

function buildValueTable(): Int8Array {
  const table = new Int8Array(128).fill(-1);
  for (let index = 0; index < ALPHABET.length; index += 1) {
    const code = ALPHABET.charCodeAt(index);
    table[code] = index;
    // Only letters get a lower-case twin. Doing it unconditionally would map '2'–'7' onto
    // 'R'–'W' as well, which decodes silently and wrongly — the exact failure this module
    // exists to prevent.
    if (code >= CODE_A && code <= CODE_Z) table[code + LOWERCASE_OFFSET] = index;
  }
  return table;
}

/**
 * Character counts a base32 string may end on.
 *
 * Each 8-character group encodes 5 bytes, and a partial group of 2, 4, 5 or 7 characters
 * encodes 1, 2, 3 or 4 bytes. A remainder of 1, 3 or 6 encodes no additional whole byte, so
 * no encoder can produce it — such a string has had a character added or lost.
 */
const VALID_REMAINDERS = new Set([0, 2, 4, 5, 7]);

/** Grouping characters a human or a web page may have inserted. Stripped, never decoded. */
const SEPARATORS = /[\s-]+/gu;

/**
 * Decodes a seed into key material.
 *
 * Returns `SecretBytes` rather than a `Uint8Array` because that is what the decoded value
 * *is*: a permanent authentication key. The wrapper is what stops it reaching a log through
 * `toString`, `toJSON` or `util.inspect`, and gives the caller a `destroy()` to call when
 * the code has been generated. **The caller owns the result and must destroy it.**
 *
 * @throws {TotpError} `INVALID_SEED`, with a message that never contains the input.
 */
export function decodeBase32Secret(seed: string): SecretBytes {
  return SecretBytes.adopt(decodeBase32(seed));
}

/**
 * The raw decode, for callers that need the bytes rather than a secret — currently only
 * `base32.test.ts`, which has to assert on them, and `encodeBase32`'s round-trip check.
 *
 * Kept separate rather than merged into `decodeBase32Secret` so that every production call
 * site is the one that returns a `SecretBytes`, and a reviewer grepping for raw seed bytes
 * finds exactly one function.
 */
export function decodeBase32(seed: string): Uint8Array {
  const compact = seed.replace(SEPARATORS, '');
  if (compact === '') throw invalidSeed('it is empty');

  const { data, padded } = splitPadding(compact);
  if (data === '') throw invalidSeed('it is nothing but padding');

  // With padding the total must be whole 8-character groups. Checked before the remainder
  // rule so that `MFRGG=` gets "the padding is the wrong length" rather than the vaguer
  // "that is not a possible length".
  if (padded && compact.length % 8 !== 0) {
    throw invalidSeed('it is padded with "=" but is not a multiple of 8 characters long');
  }
  if (!VALID_REMAINDERS.has(data.length % 8)) {
    throw invalidSeed(
      'it is a length that base32 cannot produce — a character is missing or extra'
    );
  }

  const bytes = new Uint8Array(Math.floor((data.length * BITS_PER_CHARACTER) / BITS_PER_BYTE));
  let written = 0;
  let accumulator = 0;
  let bits = 0;

  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    const value = code < 128 ? (VALUES[code] ?? -1) : -1;
    if (value < 0) {
      // The 1-based position, and nothing else. See the note on positions in `errors.ts`.
      throw invalidSeed(
        `character ${index + 1} is not valid base32 (only A–Z and 2–7 are, in any case)`
      );
    }

    accumulator = (accumulator << BITS_PER_CHARACTER) | value;
    bits += BITS_PER_CHARACTER;
    if (bits >= BITS_PER_BYTE) {
      bits -= BITS_PER_BYTE;
      bytes[written] = (accumulator >> bits) & 0xff;
      written += 1;
      // Keep only the bits still owed, so the accumulator can never overflow 31 bits.
      accumulator &= (1 << bits) - 1;
    }
  }

  if (bits > 0 && accumulator !== 0) {
    throw invalidSeed(
      'its final character carries bits that no encoder would have set — it has been truncated or mistyped'
    );
  }

  return bytes;
}

interface SplitSeed {
  readonly data: string;
  readonly padded: boolean;
}

/** Separates the data characters from trailing `=`, rejecting padding anywhere else. */
function splitPadding(compact: string): SplitSeed {
  const firstPad = compact.indexOf('=');
  if (firstPad === -1) return { data: compact, padded: false };

  const tail = compact.slice(firstPad);
  // A '=' with data after it is not padding at all; it is a character in the wrong place,
  // and trimming it would decode a different key.
  if (/[^=]/.test(tail)) throw invalidSeed('its "=" padding is not all at the end');

  return { data: compact.slice(0, firstPad), padded: true };
}

export interface Base32EncodeOptions {
  /** Emit trailing `=`. Off by default — see below. */
  readonly pad?: boolean;
}

/**
 * Encodes bytes as base32.
 *
 * **Unpadded by default.** The only production caller is `buildOtpauthSecretUri`, and `=` in
 * a query string is at best noise and at worst a parsing hazard for whatever reads the URI
 * next. Every authenticator emits unpadded seeds; matching them means a Keyhold-generated
 * URI is byte-comparable with the one the service issued.
 *
 * Upper case, always: it is what RFC 4648 specifies for the encoder, and what every printed
 * enrolment page shows.
 */
export function encodeBase32(bytes: Uint8Array, options: Base32EncodeOptions = {}): string {
  let out = '';
  let accumulator = 0;
  let bits = 0;

  for (const byte of bytes) {
    accumulator = (accumulator << BITS_PER_BYTE) | byte;
    bits += BITS_PER_BYTE;
    while (bits >= BITS_PER_CHARACTER) {
      bits -= BITS_PER_CHARACTER;
      out += ALPHABET.charAt((accumulator >> bits) & 0x1f);
      accumulator &= (1 << bits) - 1;
    }
  }

  // The leftover bits are padded with zeros on the right, which is what makes the
  // trailing-bits check in `decodeBase32` a meaningful signal rather than a coin toss.
  if (bits > 0) out += ALPHABET.charAt((accumulator << (BITS_PER_CHARACTER - bits)) & 0x1f);

  if (options.pad === true) {
    while (out.length % 8 !== 0) out += '=';
  }
  return out;
}
