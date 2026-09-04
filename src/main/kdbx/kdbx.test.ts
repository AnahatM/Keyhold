// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto/errors.js';
import { ByteWriter } from './binary.js';
import { readKdbx } from './read.js';
import { writeKdbx } from './write.js';
import { KDBX_SIGNATURE_1, KDBX_SIGNATURE_2 } from './types.js';

/**
 * KDBX 4 end to end: write a database, read it back, and refuse the files that should be.
 *
 * The pieces underneath each have their own tests, several with published known-answer
 * vectors. This file is about the seams between them — the ordering, the framing, and the
 * three refusals a user will actually meet.
 *
 * ## What a round-trip test can and cannot prove
 *
 * It proves this reader and this writer agree, which is worth having and is **not**
 * interoperability. Everything self-consistent passes a round trip: a big-endian length, a
 * keystream started at the wrong block, a header hashed over the wrong bytes. The defences
 * against that live one layer down and are deliberate — `inner-stream.test.ts` pins ChaCha20
 * against RFC 8439's own vector, `keys.test.ts` recomputes the whole key chain the long way,
 * `binary.test.ts` asserts the byte order against literal bytes rather than against itself.
 *
 * What remains unproven until somebody opens one of these files in KeePassXC is the *schema*:
 * that KeePass wants these element names, in this nesting, with times in this encoding.
 * That is a manual step and it is recorded as one — `MANUAL-BACKLOG.md`, M-KDBX-INTEROP.
 * Nothing here pretends otherwise.
 *
 * ## The bug this file's round trip actually caught
 *
 * Every protected value came back as noise from a file that was byte-for-byte correct.
 * `ByteReader.bytes` used `.slice()`, which copies for a `Uint8Array` and **returns a view**
 * for a `Buffer` — and a decompressed payload is a `Buffer`. So the inner-stream key was a
 * window onto the payload, and zeroing the payload zeroed the key. Neither the reader's unit
 * tests nor the writer's would ever have found it; only running the two together did.
 *
 * ## Fault injections, including the two that failed to fail
 *
 * 1. **The reader's keystream restarted per value.** Three cases failed.
 * 2. **The header HMAC check skipped.** Both wrong-password cases failed — that check *is*
 *    the password check.
 * 3. **The header SHA-256 check skipped: caught nothing**, twice over. The corrupted byte was
 *    a field id, so the parse failed on its own; and the assertion was loose enough that the
 *    HMAC's own refusal one step later matched it. Both fixed — the byte is now flipped
 *    inside the master seed's data, found by searching for it, and the assertion names the
 *    checksum. Re-injected, it fails.
 * 4. **The master seed, IV and KDF salt fixed to constants: caught nothing.** The test
 *    compared whole files, and the inner-stream key is random regardless, so two files differ
 *    however the header is built. Now compared over the header alone. Nonce reuse is
 *    catastrophic and this is the only case that would see it. Re-injected, it fails.
 * 5. **`Protected="True"` left on a substituted value.** Three cases failed — the file
 *    decrypts correctly and the parser then skips every password in it.
 */

/** Deliberately feeble, so the suite is not spending seconds in Argon2 per case. */
const FAST_KDF = { memoryKib: 64, iterations: 1, parallelism: 1 } as const;

const XML = [
  '<?xml version="1.0" encoding="utf-8"?><KeePassFile>',
  '<Meta><Generator>Keyhold</Generator><DatabaseName>Test</DatabaseName></Meta>',
  '<Root><Group><Name>Test</Name>',
  '<Entry><String><Key>Title</Key><Value>Example Bank</Value></String>',
  '<String><Key>Password</Key><Value Protected="True">p&lt;ss &amp; w&gt;rd</Value></String>',
  '</Entry>',
  '<Entry><String><Key>Title</Key><Value>Second</Value></String>',
  '<String><Key>Password</Key><Value Protected="True">the-second-secret</Value></String>',
  '</Entry>',
  '</Group></Root></KeePassFile>',
].join('');

async function roundTrip(xml = XML, password = 'correct-horse-battery-staple'): Promise<string> {
  const bytes = await writeKdbx({ secretXml: xml, secretPassword: password, kdf: FAST_KDF });
  return (await readKdbx(bytes, password)).xml;
}

describe('a database Keyhold wrote, read back', () => {
  it('returns every protected value in the clear', async () => {
    const xml = await roundTrip();

    expect(xml).toContain('the-second-secret');
    expect(xml).not.toContain('Protected="True"');
  });

  it('decrypts the second protected value as well as the first', async () => {
    // The one that catches a keystream restarted per value. A per-value cipher round-trips
    // perfectly — writer and reader restart in lockstep — so only a document with **two**
    // protected values can tell the difference.
    const xml = await roundTrip();

    expect(xml).toContain('<Value>the-second-secret</Value>');
  });

  it('re-escapes a value containing markup rather than breaking the document', async () => {
    // A password may contain `<` and `&`. Substituting it raw would produce a document that
    // no longer parses — from a file that was perfectly valid.
    const xml = await roundTrip();

    expect(xml).toContain('p&lt;ss &amp; w&gt;rd');
    expect(xml).not.toContain('p<ss & w>rd');
  });

  it('leaves unprotected values alone', async () => {
    expect(await roundTrip()).toContain('<Value>Example Bank</Value>');
  });

  it('carries a value with no protected content at all', async () => {
    const plain = '<KeePassFile><Root><Group><Name>Empty</Name></Group></Root></KeePassFile>';
    expect(await roundTrip(plain)).toBe(plain);
  });

  it('handles a database large enough to span several HMAC blocks', async () => {
    // A megabyte-plus payload, so the block stream is exercised rather than the one-block
    // case every small fixture would take.
    const many = Array.from({ length: 4_000 }, (_, index) =>
      [
        '<Entry><String><Key>Title</Key>',
        `<Value>Record ${String(index)}</Value></String>`,
        '<String><Key>Password</Key>',
        `<Value Protected="True">secret-${String(index)}-${'x'.repeat(60)}</Value>`,
        '</String></Entry>',
      ].join('')
    ).join('');
    const xml = `<KeePassFile><Root><Group><Name>Big</Name>${many}</Group></Root></KeePassFile>`;

    const back = await roundTrip(xml);
    expect(back).toContain('<Value>secret-0-');
    expect(back).toContain('<Value>secret-3999-');
  });

  it('generates a fresh master seed, IV and KDF salt for every file', async () => {
    // Compared over the **header**, not over the whole file, and the difference matters. A
    // first version compared whole files, and an injection that fixed the seed, the IV and the
    // salt to constants passed it — because the inner-stream key is random too and lives in
    // the encrypted body, so two files differ whatever the header does. Nonce reuse is
    // catastrophic and this is the only test that would see it.
    const first = await writeKdbx({ secretXml: XML, secretPassword: 'p', kdf: FAST_KDF });
    const second = await writeKdbx({ secretXml: XML, secretPassword: 'p', kdf: FAST_KDF });

    // Past the signature, cipher id, compression flag, master seed, IV and KDF parameters.
    const HEADER = 200;
    expect(Buffer.from(first.subarray(0, HEADER)).toString('hex')).not.toBe(
      Buffer.from(second.subarray(0, HEADER)).toString('hex')
    );
  });
});

describe('what it refuses', () => {
  it('refuses the wrong password, and says so as a wrong password', async () => {
    const bytes = await writeKdbx({ secretXml: XML, secretPassword: 'right', kdf: FAST_KDF });

    await expect(readKdbx(bytes, 'wrong')).rejects.toMatchObject({ code: 'WRONG_PASSWORD' });
  });

  it('mentions key files in the wrong-password message', async () => {
    // Not padding. A database with a key file fails at exactly this point, and a message that
    // said only "wrong password" would leave somebody retyping a password that was never the
    // whole key.
    const bytes = await writeKdbx({ secretXml: XML, secretPassword: 'right', kdf: FAST_KDF });

    await expect(readKdbx(bytes, 'wrong')).rejects.toThrow(/key file/);
  });

  it('refuses a file that is not a KeePass database', async () => {
    await expect(readKdbx(new Uint8Array(200), 'p')).rejects.toBeInstanceOf(VaultError);
  });

  it('refuses a KeePass 1 .kdb by name', async () => {
    const bytes = new ByteWriter().u32(KDBX_SIGNATURE_1).u32(0xb5_4b_fb_65).u32(0).finish();

    await expect(readKdbx(bytes, 'p')).rejects.toThrow(/KeePass 1/);
  });

  it('refuses KDBX 3 by name, with what to do about it', async () => {
    // The decision, not an omission: KDBX 3 protects its values with Salsa20, which Node does
    // not provide, and writing a stream cipher by hand is what "never invent cryptography"
    // forbids. The message has to carry the way out, because the user has a file that works
    // everywhere else.
    const bytes = new ByteWriter()
      .u32(KDBX_SIGNATURE_1)
      .u32(KDBX_SIGNATURE_2)
      .u32((3 << 16) | 1)
      .finish();

    await expect(readKdbx(bytes, 'p')).rejects.toThrow(/KDBX 3/);
    await expect(readKdbx(bytes, 'p')).rejects.toThrow(/KeePassXC/);
  });

  it('refuses a flipped bit in the payload as tampering, not as damage', async () => {
    const bytes = await writeKdbx({ secretXml: XML, secretPassword: 'p', kdf: FAST_KDF });
    // Well past the header, its checksum and its signature, so this lands inside a block.
    const target = bytes.length - 20;
    bytes[target] = (bytes[target] ?? 0) ^ 0x01;

    await expect(readKdbx(bytes, 'p')).rejects.toMatchObject({ code: 'TAMPERED' });
  });

  it('refuses a flipped bit in the header before it spends a second on Argon2', async () => {
    // The unkeyed SHA-256 catches this, and catching it *first* is the point: the checksum is
    // verified before the KDF runs, so a corrupt file fails immediately rather than after the
    // delay a real unlock takes.
    //
    // Two details are load-bearing, and a first version of this test had neither. The byte is
    // flipped inside the **master seed's data**, not in a field id — corrupting an id makes
    // the parse fail on its own, so the test would pass with the checksum deleted. And the
    // assertion names the **checksum**, because the HMAC would otherwise catch the same
    // corruption one step later and report it as a wrong password. Injected by deleting the
    // check: without both, it caught nothing.
    // The seed is located by searching for it rather than by a hard-coded offset. A constant
    // would silently start pointing at a length field the day a header field is added or
    // reordered, and the test would go on passing while guarding something else.
    const seed = new Uint8Array(32).fill(0xa7);
    const bytes = await writeKdbx({
      secretXml: XML,
      secretPassword: 'p',
      kdf: FAST_KDF,
      random: (length) => (length === 32 ? seed : new Uint8Array(length).fill(length)),
    });
    const at = Buffer.from(bytes).indexOf(Buffer.from(seed));
    expect(at, 'the master seed is not in the header where this test expects it').toBeGreaterThan(
      0
    );
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;

    await expect(readKdbx(bytes, 'p')).rejects.toThrow(/checksum/);
  });

  it('refuses a truncated file', async () => {
    const bytes = await writeKdbx({ secretXml: XML, secretPassword: 'p', kdf: FAST_KDF });

    await expect(readKdbx(bytes.slice(0, bytes.length - 40), 'p')).rejects.toBeInstanceOf(
      VaultError
    );
  });

  it('never puts the password or a value in a refusal', async () => {
    const secret = 'a-very-distinctive-password-value';
    const bytes = await writeKdbx({
      secretXml: XML.replace('the-second-secret', secret),
      secretPassword: 'right',
      kdf: FAST_KDF,
    });

    const error = await readKdbx(bytes, 'wrong').catch((thrown: unknown) => thrown);

    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain('right');
    expect(String(error)).not.toContain('wrong');
  });
});
