// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION, KDF_ID, MAGIC, type VaultContents } from '@shared/format/types.js';
import { VaultError } from '../crypto/errors.js';
import { createVaultKeys, unlock } from '../crypto/envelope.js';
import { randomBytes, randomChunkId, uuid } from '../crypto/random.js';
import type { SecretBytes } from '../crypto/secret.js';
import { readContainer, readPreamble, writeContainer } from './container.js';
import { newHeader, parseHeader, serialiseHeader } from './header.js';

/**
 * Container tests.
 *
 * The container is where "wrong password", "corrupt file" and "someone edited this"
 * become distinguishable, and where a mistake means either a false alarm on a good vault
 * or — far worse — silently loading a modified one. Every failure mode below is a real
 * way a file arrives damaged: truncated by a full disk, half-synced by a cloud client,
 * or deliberately edited.
 */

const FAST_PARAMS = {
  alg: KDF_ID,
  memoryKib: 19_456,
  iterations: 2,
  parallelism: 1,
  salt: Buffer.from(randomBytes(16)).toString('base64'),
} as const;

const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));
const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

/** Returns a copy with one byte altered. The canonical corruption probe. */
const corruptByte = (bytes: Uint8Array, index: number, mask = 0b0000_0001): Uint8Array => {
  const copy = Uint8Array.from(bytes);
  copy[index] = (copy[index] ?? 0) ^ mask;
  return copy;
};

interface Vault {
  bytes: Uint8Array;
  dek: SecretBytes;
}

/** Builds a real vault the way the app does, so tests exercise the actual path. */
async function makeVault(
  body: string,
  attachments: VaultContents['attachments'] = []
): Promise<Vault> {
  const { keys, wrappedDek } = await createVaultKeys('master-password', FAST_PARAMS);
  const header = {
    ...newHeader({ vaultId: uuid(), deviceId: uuid(), kdf: FAST_PARAMS, wrappedDek }),
    attachmentCount: attachments.length,
  };
  return {
    bytes: writeContainer(header, { body: utf8(body), attachments }, keys.dek),
    dek: keys.dek,
  };
}

describe('round trip', () => {
  it('writes and reads back an identical body', async () => {
    const { bytes, dek } = await makeVault('{"records":[]}');
    expect(text(readContainer(bytes, dek).body)).toBe('{"records":[]}');
  });

  it('survives a body with multi-byte UTF-8, which naive length handling breaks', async () => {
    const body = '{"title":"日本語 — émoji 🔐 ünïcödé"}';
    const { bytes, dek } = await makeVault(body);
    expect(text(readContainer(bytes, dek).body)).toBe(body);
  });

  it('handles an empty body', async () => {
    const { bytes, dek } = await makeVault('');
    expect(readContainer(bytes, dek).body.length).toBe(0);
  });

  it('handles a large, highly compressible body', async () => {
    const body = JSON.stringify({ padding: 'a'.repeat(2_000_000) });
    const { bytes, dek } = await makeVault(body);

    // Compression happens before encryption, so a repetitive body should produce a file
    // far smaller than its plaintext. If this ever fails, compression silently stopped.
    expect(bytes.length).toBeLessThan(body.length / 10);
    expect(text(readContainer(bytes, dek).body)).toBe(body);
  });

  it('starts every file with the KEEP signature', async () => {
    const { bytes } = await makeVault('{}');
    expect(Array.from(bytes.subarray(0, 8))).toEqual(Array.from(MAGIC));
  });

  it('opens end to end from a password, the way the app actually does', async () => {
    const { keys, wrappedDek } = await createVaultKeys('correct horse battery', FAST_PARAMS);
    const header = newHeader({
      vaultId: uuid(),
      deviceId: uuid(),
      kdf: FAST_PARAMS,
      wrappedDek,
    });
    const bytes = writeContainer(
      header,
      { body: utf8('{"secret":true}'), attachments: [] },
      keys.dek
    );

    const { header: readBack } = readPreamble(bytes);
    const reopened = await unlock('correct horse battery', readBack.kdf, readBack.wrappedDek);
    expect(text(readContainer(bytes, reopened.dek).body)).toBe('{"secret":true}');
  });
});

describe('attachments', () => {
  it('round-trips several chunks, preserving order and bytes', async () => {
    const attachments = [
      { id: randomChunkId(), data: randomBytes(1_024) },
      { id: randomChunkId(), data: randomBytes(4_096) },
      { id: randomChunkId(), data: utf8('a small text attachment') },
    ];
    const { bytes, dek } = await makeVault('{}', attachments);
    const read = readContainer(bytes, dek);

    expect(read.attachments.map((a) => a.id)).toEqual(attachments.map((a) => a.id));
    for (let i = 0; i < attachments.length; i += 1) {
      expect(read.attachments[i]?.data).toEqual(attachments[i]?.data);
    }
  });

  it('handles a zero-byte attachment', async () => {
    const attachments = [{ id: randomChunkId(), data: new Uint8Array(0) }];
    const { bytes, dek } = await makeVault('{}', attachments);
    expect(readContainer(bytes, dek).attachments[0]?.data.length).toBe(0);
  });

  it('binds each chunk to its id, so chunks cannot be swapped between records', async () => {
    // Without id-as-AAD an attacker who can edit the file could move a valid encrypted
    // chunk onto a different record's id and it would decrypt happily.
    const a = { id: randomChunkId(), data: utf8('belongs to record A') };
    const b = { id: randomChunkId(), data: utf8('belongs to record B') };
    const { bytes, dek } = await makeVault('{}', [a, b]);

    // Overwrite the first chunk's id with the second's.
    const swapped = Uint8Array.from(bytes);
    const firstIdOffset = bytes.length - findChunkRegionLength([a, b]);
    const idBytes = Buffer.from(b.id, 'hex');
    swapped.set(idBytes, firstIdOffset);

    expect(() => readContainer(swapped, dek)).toThrow(VaultError);
  });

  it('rejects an attachment id that is not 16 bytes of hex', async () => {
    const { keys, wrappedDek } = await createVaultKeys('p', FAST_PARAMS);
    const header = newHeader({ vaultId: uuid(), deviceId: uuid(), kdf: FAST_PARAMS, wrappedDek });

    expect(() =>
      writeContainer(
        header,
        { body: utf8('{}'), attachments: [{ id: 'not-hex', data: new Uint8Array(1) }] },
        keys.dek
      )
    ).toThrow(/hex characters/);
  });

  it('rejects a file whose header disagrees with the attachments present', async () => {
    // Catches a truncated tail: the records survive, an attachment silently vanishes.
    const attachments = [{ id: randomChunkId(), data: randomBytes(64) }];
    const { keys, wrappedDek } = await createVaultKeys('p', FAST_PARAMS);
    const header = {
      ...newHeader({ vaultId: uuid(), deviceId: uuid(), kdf: FAST_PARAMS, wrappedDek }),
      attachmentCount: 5, // a lie
    };
    const bytes = writeContainer(header, { body: utf8('{}'), attachments }, keys.dek);

    expect(() => readContainer(bytes, keys.dek)).toThrow(/declares 5 attachments/);
  });
});

describe('rejecting damaged and hostile files', () => {
  it('rejects a file that is not a vault', () => {
    expect(() => readPreamble(utf8('this is a text file, not a vault'))).toThrow(
      expect.objectContaining({ code: 'NOT_A_VAULT' }) as Error
    );
  });

  it('rejects an empty file', () => {
    expect(() => readPreamble(new Uint8Array(0))).toThrow(VaultError);
  });

  it('refuses a newer format version instead of guessing at it', async () => {
    const { bytes } = await makeVault('{}');
    const future = Uint8Array.from(bytes);
    Buffer.from(future.buffer, future.byteOffset).writeUInt16LE(FORMAT_VERSION + 1, 8);

    const error = catchError(() => readPreamble(future));
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe('UNSUPPORTED_VERSION');
    // The message must tell the user their data is intact, or they will panic and
    // start "fixing" the file.
    expect(error?.message).toMatch(/not been modified/i);
  });

  it('detects a preamble version that disagrees with the header version', async () => {
    const { bytes } = await makeVault('{}');
    const edited = Uint8Array.from(bytes);
    Buffer.from(edited.buffer, edited.byteOffset).writeUInt16LE(0, 8);
    expect(() => readPreamble(edited)).toThrow(VaultError);
  });

  it('detects truncation at every length', async () => {
    const { bytes, dek } = await makeVault('{"records":[{"id":"a"}]}');

    // Every prefix of a valid vault must fail cleanly — never return partial data, and
    // never throw something other than a VaultError.
    for (let cut = 1; cut < bytes.length; cut += Math.max(1, Math.floor(bytes.length / 40))) {
      const error = catchError(() => readContainer(bytes.subarray(0, cut), dek));
      expect(error, `truncating to ${cut} bytes should fail`).toBeInstanceOf(VaultError);
    }
  });

  it('detects a flipped bit anywhere in the encrypted body', async () => {
    const { bytes, dek } = await makeVault('{"records":[{"password":"hunter2"}]}');
    const { bodyOffset } = readPreamble(bytes);

    // Sample across the body rather than every byte — the property is uniform, and
    // testing all of it would just be slow.
    for (let offset = bodyOffset + 8; offset < bytes.length; offset += 7) {
      const error = catchError(() => readContainer(corruptByte(bytes, offset), dek));
      expect(error, `flipping a bit at ${offset} should be detected`).toBeInstanceOf(VaultError);
    }
  });

  it('detects header tampering — this is what AAD buys us', async () => {
    const { keys, wrappedDek } = await createVaultKeys('master-password', FAST_PARAMS);
    const header = newHeader({ vaultId: uuid(), deviceId: uuid(), kdf: FAST_PARAMS, wrappedDek });
    const bytes = writeContainer(header, { body: utf8('{"a":1}'), attachments: [] }, keys.dek);

    // Rewrite the header with a bumped generation counter, keeping the length identical
    // so the file stays structurally valid. Only the AAD binding catches this.
    const forged = serialiseHeader({ ...header, generation: 9 });
    const original = serialiseHeader(header);
    expect(forged.length).toBe(original.length);

    const edited = Uint8Array.from(bytes);
    edited.set(forged, 14);

    const error = catchError(() => readContainer(edited, keys.dek));
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe('TAMPERED');
  });

  it('reports body tampering as TAMPERED, not as a wrong password', async () => {
    // The distinction matters: telling someone their password is wrong when the file is
    // actually corrupt sends them off retyping a password that was never the problem.
    const { bytes, dek } = await makeVault('{"a":1}');
    const { bodyOffset } = readPreamble(bytes);
    const error = catchError(() => readContainer(corruptByte(bytes, bodyOffset + 20, 0xff), dek));
    expect((error as VaultError).code).toBe('TAMPERED');
  });

  it('fails to read the body with the wrong key', async () => {
    const { bytes } = await makeVault('{"a":1}');
    const other = await createVaultKeys('a-different-vault', FAST_PARAMS);
    expect(() => readContainer(bytes, other.keys.dek)).toThrow(VaultError);
  });

  it('rejects an absurd declared body length rather than trying to allocate it', async () => {
    const { bytes, dek } = await makeVault('{}');
    const { bodyOffset } = readPreamble(bytes);
    const bomb = Uint8Array.from(bytes);
    Buffer.from(bomb.buffer, bomb.byteOffset).writeUInt32LE(0xff_ff_ff_ff, bodyOffset);

    const error = catchError(() => readContainer(bomb, dek));
    expect(error).toBeInstanceOf(VaultError);
    expect(['TOO_LARGE', 'MALFORMED']).toContain((error as VaultError).code);
  });
});

describe('header parsing treats the file as hostile', () => {
  const validHeader = (): ReturnType<typeof newHeader> =>
    newHeader({
      vaultId: uuid(),
      deviceId: uuid(),
      kdf: FAST_PARAMS,
      wrappedDek: { nonce: 'AAAA', ciphertext: 'AAAA', tag: 'AAAA' },
    });

  it('round-trips a valid header exactly', () => {
    const header = validHeader();
    expect(parseHeader(serialiseHeader(header))).toEqual(header);
  });

  it('serialises keys in a fixed order, because the bytes are the AAD', () => {
    // If key order ever varied, every existing vault would fail authentication. Asserting
    // the exact prefix makes that a loud failure rather than a mystery.
    const json = Buffer.from(serialiseHeader(validHeader())).toString('utf8');
    expect(json.startsWith('{"formatVersion":')).toBe(true);
    expect(json.indexOf('"vaultId"')).toBeLessThan(json.indexOf('"kdf"'));
    expect(json.indexOf('"kdf"')).toBeLessThan(json.indexOf('"cipher"'));
    expect(json.indexOf('"cipher"')).toBeLessThan(json.indexOf('"wrappedDek"'));
  });

  it('rejects malformed JSON', () => {
    expect(() => parseHeader(utf8('{not json'))).toThrow(/not valid JSON/);
  });

  it('rejects a JSON array or primitive where an object is required', () => {
    expect(() => parseHeader(utf8('[]'))).toThrow(/not a JSON object/);
    expect(() => parseHeader(utf8('42'))).toThrow(/not a JSON object/);
    expect(() => parseHeader(utf8('null'))).toThrow(/not a JSON object/);
  });

  it('rejects an unknown cipher rather than falling back to a default', () => {
    const raw = JSON.parse(Buffer.from(serialiseHeader(validHeader())).toString('utf8')) as Record<
      string,
      unknown
    >;
    raw.cipher = 'DES-ECB';
    expect(() => parseHeader(utf8(JSON.stringify(raw)))).toThrow(/unsupported cipher/);
  });

  it('rejects a wrong-typed field instead of coercing it', () => {
    const raw = JSON.parse(Buffer.from(serialiseHeader(validHeader())).toString('utf8')) as Record<
      string,
      unknown
    >;
    raw.generation = '3';
    expect(() => parseHeader(utf8(JSON.stringify(raw)))).toThrow(/not an integer/);
  });

  it('rejects a negative count', () => {
    const raw = JSON.parse(Buffer.from(serialiseHeader(validHeader())).toString('utf8')) as Record<
      string,
      unknown
    >;
    raw.recordCount = -1;
    expect(() => parseHeader(utf8(JSON.stringify(raw)))).toThrow(/negative/);
  });

  it('rejects a missing required field', () => {
    const raw = JSON.parse(Buffer.from(serialiseHeader(validHeader())).toString('utf8')) as Record<
      string,
      unknown
    >;
    delete raw.vaultId;
    expect(() => parseHeader(utf8(JSON.stringify(raw)))).toThrow(/vaultId/);
  });

  it('rejects a wrappedDek that is not an object', () => {
    const raw = JSON.parse(Buffer.from(serialiseHeader(validHeader())).toString('utf8')) as Record<
      string,
      unknown
    >;
    raw.wrappedDek = 'nope';
    expect(() => parseHeader(utf8(JSON.stringify(raw)))).toThrow(/not an object/);
  });

  it('rejects a field that is not valid base64', () => {
    // Node's base64 decoder silently drops invalid characters, so without an explicit
    // check a corrupted salt would decode to something shorter and simply derive the
    // wrong key — reported to the user as "wrong password".
    const raw = JSON.parse(Buffer.from(serialiseHeader(validHeader())).toString('utf8')) as Record<
      string,
      unknown
    >;
    (raw.kdf as Record<string, unknown>).salt = 'not valid base64!!!';
    expect(() => parseHeader(utf8(JSON.stringify(raw)))).toThrow(/base64/);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function catchError(fn: () => unknown): Error | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

/** Byte length of the attachment region, used to locate the first chunk id. */
function findChunkRegionLength(attachments: readonly { data: Uint8Array }[]): number {
  // id(16) + length(4) + nonce(12) + ciphertext + tag(16), per attachment.
  return attachments.reduce((total, a) => total + 16 + 4 + 12 + a.data.length + 16, 0);
}
