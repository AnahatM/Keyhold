// SPDX-License-Identifier: GPL-3.0-or-later
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { VaultError } from '../crypto/errors.js';
import { ByteReader } from './binary.js';
import { blockKey, readBlocks } from './blocks.js';
import { readInnerHeader, readOuterHeader } from './header.js';
import { createInnerStream } from './inner-stream.js';
import { deriveCompositeKey, deriveKdbxKeys } from './keys.js';
import {
  CIPHER_CHACHA20,
  HEADER_HMAC_INDEX,
  MAX_PAYLOAD,
  badKdbx,
  type KdbxBinary,
  type KdbxOuterHeader,
} from './types.js';

/**
 * Opening a KDBX 4 database: bytes and a password in, XML and attachments out.
 *
 * This is the whole read, in the one order it is allowed to happen:
 *
 * 1. **Parse the outer header.** Plaintext, and readable before any key exists.
 * 2. **Check its SHA-256.** Catches corruption, and nothing else — it is unkeyed, so anyone
 *    editing the header can recompute it. It is a checksum wearing a hash's clothes.
 * 3. **Derive the keys**, which is where the Argon2 seconds go.
 * 4. **Check the header's HMAC.** This is the real check, and it is also the password check:
 *    the HMAC key comes from the master key, so a wrong password fails here and nowhere
 *    later. That is why a wrong password reports `WRONG_PASSWORD` while a modified header
 *    reports the same thing — from outside they are indistinguishable, and pretending
 *    otherwise would leak which one it was.
 * 5. **Read and authenticate the block stream**, block by block, before decrypting anything.
 * 6. **Decrypt**, then decompress, then read the inner header, then the XML.
 *
 * The ordering is the security property. A reader that decrypted first and authenticated
 * afterwards would be feeding attacker-chosen ciphertext to a padding-sensitive CBC decrypt,
 * which is the padding-oracle shape exactly.
 *
 * ## What this deliberately does not do
 *
 * **Keyfiles and Windows-account credentials are not supported.** A database protected by one
 * fails the HMAC check and is reported as a wrong password, which is honest but unhelpful, so
 * the message says so out loud rather than leaving somebody retyping a password that was
 * never the whole key.
 *
 * **Nothing here maps records.** The XML that comes out is handed to
 * `import/keepass-xml.ts`, which already knows the schema — the same arrangement as D30,
 * where a `.keep` is decrypted and handed to the JSON parser that already exists. A second
 * mapping for the same schema would be rule 8's second list, and the two would disagree the
 * first time one of them was fixed.
 */

export interface KdbxReadResult {
  /**
   * The inner XML, with every protected value decrypted **in place** and re-escaped.
   *
   * Handed on as a string rather than a parse tree because the consumer is a parser, and
   * because the substitution below has to happen in document order over the raw bytes anyway.
   */
  readonly xml: string;
  /** Attachments from the inner header. Counted and reported by the importer, not imported. */
  readonly binaries: readonly KdbxBinary[];
  /** What the file said about itself, for the import report. Holds no secret material. */
  readonly header: KdbxOuterHeader;
}

/** The wrong-password message, in one place because two paths reach it. */
function wrongPassword(): VaultError {
  return new VaultError(
    'WRONG_PASSWORD',
    'That password did not open this database. If it is protected by a key file or a Windows account as well as a password, Keyhold cannot open it — it supports a password alone.'
  );
}

export async function readKdbx(bytes: Uint8Array, secretPassword: string): Promise<KdbxReadResult> {
  const reader = new ByteReader(bytes);
  const header = readOuterHeader(reader);

  const storedSha = reader.bytes(32, 'the header checksum');
  const actualSha = createHash('sha256').update(header.raw).digest();
  if (!timingSafeEqual(storedSha, actualSha)) {
    throw badKdbx('its header checksum does not match, so the file is damaged');
  }

  const storedHmac = reader.bytes(32, 'the header signature');

  const secretComposite = deriveCompositeKey(secretPassword);
  const keys = await deriveKdbxKeys(secretComposite, header.masterSeed, header.kdf);
  secretComposite.fill(0);

  try {
    const authenticated = keys.secretHmacKey.use((hmacKey) => {
      const headerKey = blockKey(hmacKey, HEADER_HMAC_INDEX);
      const actual = createHmac('sha256', headerKey).update(header.raw).digest();
      headerKey.fill(0);
      return timingSafeEqual(storedHmac, actual);
    });
    if (!authenticated) throw wrongPassword();

    const framed = keys.secretHmacKey.use((hmacKey) => readBlocks(reader, hmacKey));
    const decrypted = keys.secretCipherKey.use((cipherKey) =>
      decryptPayload(header, cipherKey, framed)
    );
    framed.fill(0);

    const payload = header.compressed ? decompress(decrypted) : decrypted;
    if (payload !== decrypted) decrypted.fill(0);

    const { header: inner, xmlOffset } = readInnerHeader(payload);
    const xml = Buffer.from(payload.subarray(xmlOffset)).toString('utf8');
    payload.fill(0);

    return {
      xml: revealProtectedValues(xml, inner.streamId, inner.streamKey),
      binaries: inner.binaries,
      header,
    };
  } finally {
    // In a `finally` rather than at the end: a refusal part-way through is the common case —
    // a wrong password is *the* common case — and a key that outlives the attempt is a key
    // sitting in memory for the rest of the session for no reason at all.
    keys.destroy();
  }
}

function decryptPayload(
  header: KdbxOuterHeader,
  cipherKey: Uint8Array,
  framed: Uint8Array
): Uint8Array {
  if (header.cipher === CIPHER_CHACHA20) {
    // Node's ChaCha20 takes a 16-byte IV: a 4-byte little-endian initial block counter
    // followed by the 12-byte nonce. KDBX supplies the nonce and starts the counter at zero,
    // so the four leading zeroes are the counter and not padding.
    const iv = new Uint8Array(16);
    iv.set(header.encryptionIv, 4);
    const cipher = createDecipheriv('chacha20', cipherKey, iv);
    return Buffer.concat([cipher.update(framed), cipher.final()]);
  }

  const cipher = createDecipheriv('aes-256-cbc', cipherKey, header.encryptionIv);
  try {
    return Buffer.concat([cipher.update(framed), cipher.final()]);
  } catch {
    // Reached only after the block HMACs have all verified, so the ciphertext is genuinely
    // the one that was written. Bad padding here therefore means the *key* is wrong in a way
    // the HMAC did not catch, which should be impossible — and the error is swallowed rather
    // than surfaced because a padding error's presence or absence is the padding oracle.
    throw badKdbx('it could not be decrypted, although its contents authenticated');
  }
}

function decompress(payload: Uint8Array): Uint8Array {
  try {
    // `maxOutputLength` is the guard, and it is enforced by zlib rather than checked after the
    // fact — which is the only version that helps. A gzip bomb is small on disk and enormous
    // decompressed, so a check on the result runs after the allocation that was the attack.
    return gunzipSync(payload, { maxOutputLength: MAX_PAYLOAD });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new VaultError(
        'TOO_LARGE',
        'This KeePass database expands to more than Keyhold will read in one go.'
      );
    }
    throw badKdbx('its compressed contents could not be read');
  }
}

/**
 * Decrypts every `Protected="True"` value, in document order, and puts the plaintext back.
 *
 * ## Why this is a string pass and not a tree walk
 *
 * The inner stream is **one continuous keystream** consumed in document order, so the second
 * protected value is decrypted with the bytes that follow the first one's. That ordering is a
 * property of the document's byte sequence, which is exactly what a regex replace walks and
 * what a tree walk would have to reconstruct.
 *
 * ## Why a regex over XML is defensible *here*, having been refused everywhere else
 *
 * `xml-reader.ts` exists because parsing XML with a regex is wrong. This is the narrow case
 * where it is not, and the reason is the content: a protected value's text is **base64**, so
 * it cannot contain `<`, `>` or `&`, and the match cannot be ended early by the data. The
 * attribute list is matched with `[^>]*`, which is safe for the same reason — no attribute in
 * this schema carries a `>`. The document is then parsed properly, by the real reader, from
 * the string this produces.
 *
 * The `Protected` attribute is **removed** as the value is substituted, so what reaches the
 * parser is an ordinary value. Leaving it would tell `keepass-xml.ts` to skip a value it can
 * now read, which is how a correct decryption still loses every password.
 */
function revealProtectedValues(xml: string, streamId: number, streamKey: Uint8Array): string {
  const stream = createInnerStream(streamId, streamKey);

  return xml.replace(
    /<Value([^>]*?)\sProtected\s*=\s*"(?:True|true)"([^>]*)>([^<]*)<\/Value>/g,
    (_whole, before: string, after: string, encoded: string) => {
      const cipherText = Buffer.from(encoded.trim(), 'base64');
      const plain = stream.process(cipherText);
      const attributes = `${before}${after}`.trim();
      return `<Value${attributes === '' ? '' : ` ${attributes}`}>${escapeXml(
        Buffer.from(plain).toString('utf8')
      )}</Value>`;
    }
  );
}

/**
 * Escapes text for an XML element body.
 *
 * `>` is escaped as well as `<` and `&`, which is not strictly required — a bare `>` is legal
 * in content. It is escaped anyway because the one sequence that is *not* legal is `]]>`, and
 * escaping every `>` makes that unrepresentable without a special case that could be missed.
 */
function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
