// SPDX-License-Identifier: GPL-3.0-or-later
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { DEFAULT_KDF_PARAMS } from '@shared/format/types.js';
import { ByteWriter } from './binary.js';
import { blockKey, writeBlocks } from './blocks.js';
import { writeInnerHeader, writeOuterHeader } from './header.js';
import { createInnerStream } from './inner-stream.js';
import { deriveCompositeKey, deriveKdbxKeys, readKdfParameters } from './keys.js';
import {
  CIPHER_AES256_CBC,
  HEADER_HMAC_INDEX,
  INNER_STREAM_CHACHA20,
  KDF_ARGON2ID,
  type KdbxBinary,
  type VariantValue,
} from './types.js';

/**
 * Writing a KDBX 4 database: XML and a password in, a file KeePassXC opens out.
 *
 * The exact inverse of `read.ts`, in the inverse order — protect the values, prepend the
 * inner header, compress, encrypt, frame in authenticated blocks, and only then write the
 * outer header with its checksum and its signature over itself.
 *
 * ## The choices this writer makes, and why each one
 *
 * **AES-256-CBC, not ChaCha20.** ChaCha20 is the better cipher and Keyhold's reader handles
 * both. AES is what every KeePass build has supported for the longest, and this format exists
 * so somebody can *leave* — a file that the recipient's older KeePass port cannot open is a
 * file that failed at its only job. The reader is where we are generous; the writer is where
 * we are conservative.
 *
 * **Argon2id, not KeePass's default Argon2d.** Both are legal in KDBX 4 and KeePassXC reads
 * either. Argon2id is the side-channel-hardened variant and is what this app already uses for
 * its own vaults (D14), so using it here means one KDF strength decision in the codebase
 * rather than two that can drift.
 *
 * **The KDF parameters are Keyhold's own defaults**, imported rather than restated — rule 8.
 * A second set of cost constants here would quietly become the weaker one.
 *
 * **Compressed.** Not for size: gzip before encryption is normal for this format, KeePass
 * writes it, and a reader that has never seen an uncompressed one is a reader with an
 * untested branch.
 *
 * ## What a KDBX export cannot carry
 *
 * KeePass has no home for Keyhold's version history, its per-record origins, or its security
 * questions as structured data. Those are the caller's losses to report — this file writes
 * whatever XML it is handed and does not decide what goes in it.
 */

export interface WriteKdbxInput {
  /**
   * The database XML, with values to protect marked `Protected="True"` **in the clear**.
   *
   * Plaintext, deliberately: this file encrypts them, in document order, on the way out. The
   * alternative — asking the XML builder to call an `encrypt` function in the right order —
   * makes correctness depend on the order somebody happens to concatenate strings in.
   */
  readonly secretXml: string;
  readonly secretPassword: string;
  /** Overridable only so a test can run in milliseconds. Production uses the defaults. */
  readonly kdf?: {
    readonly memoryKib?: number;
    readonly iterations?: number;
    readonly parallelism?: number;
  };
  /** Injectable so a test can pin a file byte for byte. Production uses `crypto.randomBytes`. */
  readonly random?: (length: number) => Uint8Array;
  /**
   * The inner header's binary pool — a KDBX file's attachments.
   *
   * **Empty in production, and that is a decision rather than an omission:** Keyhold does not
   * carry attachments into a KDBX export, and the export screen says so rather than dropping
   * them silently.
   *
   * It is injectable for the same reason `kdf` and `random` above are — so a test can build a
   * file production does not. Specifically, it makes the *reader's* attachment path
   * reachable: that path counts binaries out of the inner header and appends the marker the
   * wizard turns into "N attachments were not imported". Before this, the only database with
   * a binary in it was one KeePassXC had written, so the branch could be reached by hand and
   * by nothing else. `writeInnerHeader` has always accepted these; only this call site
   * insisted on none.
   */
  readonly binaries?: readonly KdbxBinary[];
}

export async function writeKdbx(input: WriteKdbxInput): Promise<Uint8Array> {
  const random = input.random ?? ((length: number) => new Uint8Array(randomBytes(length)));

  const masterSeed = random(32);
  const encryptionIv = random(16);
  const kdfSalt = random(32);
  const streamKey = random(64);

  const kdfParameters: ReadonlyMap<string, VariantValue> = new Map<string, VariantValue>([
    ['$UUID', Buffer.from(KDF_ARGON2ID, 'hex')],
    ['S', kdfSalt],
    ['I', BigInt(input.kdf?.iterations ?? DEFAULT_KDF_PARAMS.iterations)],
    // The file states memory in **bytes**; Keyhold's own parameters are in kibibytes.
    ['M', BigInt(input.kdf?.memoryKib ?? DEFAULT_KDF_PARAMS.memoryKib) * 1024n],
    ['P', input.kdf?.parallelism ?? DEFAULT_KDF_PARAMS.parallelism],
    // 0x13 — Argon2 version 1.3, the current one. 0x10 exists and nothing should write it.
    ['V', 0x13],
  ]);

  const secretComposite = deriveCompositeKey(input.secretPassword);
  const keys = await deriveKdbxKeys(
    secretComposite,
    masterSeed,
    // Round-tripped through the reader's own validation rather than constructed directly, so
    // this writer cannot emit a file its own reader would refuse — the cheapest possible
    // guard against the two drifting, and it costs a map lookup.
    readKdfParameters(kdfParameters)
  );
  secretComposite.fill(0);

  try {
    const inner = writeInnerHeader({
      streamId: INNER_STREAM_CHACHA20,
      streamKey,
      binaries: input.binaries ?? [],
    });

    const protectedXml = protectValues(input.secretXml, INNER_STREAM_CHACHA20, streamKey);
    const payload = new ByteWriter()
      .bytes(inner)
      .bytes(new Uint8Array(Buffer.from(protectedXml, 'utf8')))
      .finish();

    const compressed = new Uint8Array(gzipSync(payload));
    payload.fill(0);

    const ciphertext = keys.secretCipherKey.use((cipherKey) => {
      const cipher = createCipheriv('aes-256-cbc', cipherKey, encryptionIv);
      return new Uint8Array(Buffer.concat([cipher.update(compressed), cipher.final()]));
    });

    const header = writeOuterHeader({
      cipher: CIPHER_AES256_CBC,
      compressed: true,
      masterSeed,
      encryptionIv,
      kdfParameters,
    });

    const sha = new Uint8Array(createHash('sha256').update(header).digest());
    const hmac = keys.secretHmacKey.use((hmacKey) => {
      const headerKey = blockKey(hmacKey, HEADER_HMAC_INDEX);
      const digest = new Uint8Array(createHmac('sha256', headerKey).update(header).digest());
      headerKey.fill(0);
      return digest;
    });
    const blocks = keys.secretHmacKey.use((hmacKey) => writeBlocks(ciphertext, hmacKey));

    return new ByteWriter().bytes(header).bytes(sha).bytes(hmac).bytes(blocks).finish();
  } finally {
    keys.destroy();
    streamKey.fill(0);
  }
}

/**
 * Encrypts every `Protected="True"` value in place, in document order.
 *
 * The exact inverse of `read.ts`'s `revealProtectedValues`, and deliberately the same shape:
 * one continuous keystream consumed in the order the values appear, which is a property of
 * the byte sequence rather than of the tree. The same argument applies for why a regex is
 * defensible here — the builder has already escaped the text, so no raw `<` can end a match
 * early, and the document is never parsed from this string by us.
 */
function protectValues(xml: string, streamId: number, streamKey: Uint8Array): string {
  const stream = createInnerStream(streamId, streamKey);

  return xml.replace(
    /<Value([^>]*?)\sProtected\s*=\s*"(?:True|true)"([^>]*)>([^<]*)<\/Value>/g,
    (_whole, before: string, after: string, escaped: string) => {
      const plain = Buffer.from(unescapeXml(escaped), 'utf8');
      const sealed = Buffer.from(stream.process(plain)).toString('base64');
      plain.fill(0);
      const attributes = `${before}${after}`.trim();
      const spacer = attributes === '' ? '' : ` ${attributes}`;
      return `<Value Protected="True"${spacer}>${sealed}</Value>`;
    }
  );
}

/** The five predefines, and nothing else — matching what `import/xml-reader.ts` resolves. */
function unescapeXml(value: string): string {
  return (
    value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      // `&amp;` last, so `&amp;lt;` becomes `&lt;` rather than `<`. The classic double-unescape
      // bug, and it corrupts exactly the passwords that contain an ampersand.
      .replace(/&amp;/g, '&')
  );
}
