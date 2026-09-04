// SPDX-License-Identifier: GPL-3.0-or-later
import { createCipheriv, createHash } from 'node:crypto';
import { SecretBytes } from '../crypto/secret.js';
import { badKdbx, INNER_STREAM_CHACHA20, INNER_STREAM_SALSA20 } from './types.js';

/**
 * The KDBX **inner random stream** — the second layer of encryption, inside the first.
 *
 * Decrypting a `.kdbx` yields XML, but the XML is not yet readable: every value KeePass
 * considers sensitive is still ciphertext, base64-encoded inside its own element.
 *
 * ```xml
 * <Value Protected="True">2VBmTA==</Value>
 * ```
 *
 * The inner header supplies a stream id and a stream key, and those two produce **one
 * continuous keystream** that every protected value in the document is XORed against, in
 * turn. This exists so that KeePass can hold the decrypted XML in memory with the passwords
 * still covered — the same instinct as this project's safe projection (D13), arrived at from
 * the other direction.
 *
 * ## The one property that matters: continuity
 *
 * There is no per-value nonce and no per-value counter. The second protected value is
 * decrypted with the keystream bytes that follow the first value's, the third with the bytes
 * that follow the second's, **in document order**. Restarting the stream per value is the
 * classic way to implement this wrongly: the first value comes out perfectly readable and
 * every value after it comes out as noise, which reads like a corrupt file rather than like a
 * bug in this module. That is why `createInnerStream` returns an object holding a live cipher
 * rather than exposing a stateless `decryptValue(key, data)`, and why the cipher is never
 * re-created between calls.
 *
 * The caller therefore owns the ordering: it must feed protected values to `process` in the
 * order they appear in the file, and must not skip one. A stream is single-use in one
 * direction over one document; reading and writing need two of them.
 *
 * ## Derivation (ChaCha20, stream id 3)
 *
 * The stream key in the inner header is of arbitrary length, so KeePass hashes it to a fixed
 * size: `h = SHA-512(streamKey)`, then ChaCha20 key `= h[0..32)`, nonce `= h[32..44)`, block
 * counter starting at **0**.
 *
 * ## Node's ChaCha20 IV layout, and how it was checked
 *
 * `crypto.createCipheriv('chacha20', key, iv)` on Node 22 wants a **16-byte** IV, not the
 * 12-byte nonce the RFC talks about — it is the full 4-word ChaCha20 counter/nonce region:
 * a **4-byte little-endian initial block counter followed by the 12-byte nonce**. Passing the
 * bare 12-byte nonce throws `Invalid initialization vector`, which at least fails loudly; the
 * dangerous mistake is the silent one, because a wrong counter shifts the entire keystream by
 * a whole 64-byte block and nothing goes wrong until the 65th byte of the document.
 *
 * This was verified against RFC 8439 §2.4.2 before any of this was built, and the check is
 * kept as a test rather than a memory: `iv = 01 00 00 00 || nonce` reproduces the RFC's
 * counter-1 ciphertext exactly, `00 00 00 01 || nonce` and `nonce || 01 00 00 00` do not, and
 * counter 0 followed by discarding 64 bytes lands on the same place as counter 1 — which is
 * what pins the leading word as a little-endian *block* counter and not something else.
 *
 * So a zero-filled first four bytes is not laziness here: it *is* KDBX's "counter starts at
 * zero", and the `Buffer.alloc` that produces it says so.
 *
 * ## Salsa20 is refused, not implemented
 *
 * Stream id 2 is KDBX 3's Salsa20. Node does not provide it, and hand-writing a stream cipher
 * is exactly what "never invent cryptography" forbids — see the header of `types.ts` on why
 * that is a decision rather than a gap. It is refused **by name**, with the one instruction
 * that actually fixes it, because "unsupported" tells a user nothing they can act on.
 *
 * Everything here is composition: Node's ChaCha20, Node's SHA-512, and a 16-byte buffer.
 */

/** ChaCha20's key, from `h[0..32)`. */
const CHACHA20_KEY_BYTES = 32;

/** ChaCha20's nonce, from `h[32..44)`. */
const CHACHA20_NONCE_BYTES = 12;

/** Node's IV for `chacha20`: the 4-byte LE block counter plus the 12-byte nonce. */
const CHACHA20_IV_BYTES = 16;

/**
 * Node's name for it. Present since Node 12 via OpenSSL; `crypto.getCiphers()` lists it, and
 * this is not the AEAD `chacha20-poly1305` — there is no tag here, because the outer HMAC is
 * what authenticates a KDBX file.
 */
const CHACHA20 = 'chacha20';

export interface InnerStream {
  /**
   * The next `length` keystream bytes, XORed into a copy of `data`.
   *
   * One method rather than `encrypt` and `decrypt`, because XOR is its own inverse: the same
   * call with the same stream position does both, and offering two names would imply a
   * distinction that does not exist and invite a caller to think one of them is safe to
   * repeat. `data` is not modified.
   *
   * Consumes exactly `data.length` bytes of the keystream — an empty input therefore consumes
   * nothing, which is what makes an empty `<Value Protected="True"/>` harmless rather than a
   * one-position desynchronisation of everything after it.
   */
  process(data: Uint8Array): Uint8Array;
}

/**
 * Opens the inner random stream described by an inner header.
 *
 * Throws `badKdbx` for Salsa20, for an unknown id, and for a missing stream key. None of those
 * messages carry the key, and this file never logs.
 *
 * `streamKey` keeps the name `KdbxInnerHeader.streamKey` gives it rather than gaining a
 * `Secret` suffix, so that there is one name for the field across the folder; the material it
 * derives is held in a `SecretBytes` and destroyed here instead.
 */
export function createInnerStream(streamId: number, streamKey: Uint8Array): InnerStream {
  if (streamId === INNER_STREAM_SALSA20) {
    throw badKdbx(
      'it protects its stored values with Salsa20, which belongs to the older KDBX 3 format ' +
        'and which Keyhold does not implement — open the database in KeePassXC and save it ' +
        'again to convert it to KDBX 4, then import it'
    );
  }

  if (streamId !== INNER_STREAM_CHACHA20) {
    throw badKdbx(
      `its inner header asks for stream cipher ${streamId}, which KDBX 4 does not define`
    );
  }

  // Not pedantry about a length: an absent stream key would hash to a *fixed, publishable*
  // keystream, so every protected value in the file would be readable by anyone. A file in
  // that state is not one to quietly carry on reading.
  if (streamKey.length === 0) {
    throw badKdbx('its inner header carries no stream key, so its protected values are unreadable');
  }

  // The digest is key material for the rest of this stream's life, so it is a secret from the
  // moment it exists — not from the moment it is split.
  const derivedSecret = SecretBytes.adopt(
    new Uint8Array(createHash('sha512').update(streamKey).digest())
  );

  const cipher = derivedSecret.use((h) => {
    // Zero-filled, and the first four bytes are then left alone: that is the block counter
    // starting at 0, which is what KDBX specifies. See the header on why this is load-bearing.
    const iv = Buffer.alloc(CHACHA20_IV_BYTES);
    iv.set(h.subarray(CHACHA20_KEY_BYTES, CHACHA20_KEY_BYTES + CHACHA20_NONCE_BYTES), 4);

    return createCipheriv(CHACHA20, h.subarray(0, CHACHA20_KEY_BYTES), iv);
  });

  // Only our copy of the digest goes; the cipher object holds the key internally for as long
  // as the stream is alive, which is by design and is the whole point of keeping it.
  derivedSecret.destroy();

  return {
    process(data: Uint8Array): Uint8Array {
      // The single `cipher` captured above is what makes the keystream continuous. Creating
      // one here instead would restart it at block 0 on every value.
      //
      // Copied out of the returned `Buffer` rather than handed over as-is: Node pools small
      // Buffers, and a view onto a shared pool is not somewhere to leave a decrypted password
      // reachable from unrelated code.
      return new Uint8Array(cipher.update(data));
    },
  };
}
