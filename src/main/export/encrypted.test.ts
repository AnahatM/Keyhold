// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { MIN_KDF_PARAMS, type AttachmentChunk } from '@shared/format/types.js';
import { unlock } from '../crypto/envelope.js';
import { VaultError } from '../crypto/errors.js';
import { readContainer, readPreamble } from '../format/container.js';
import { parseVaultDocument } from '../vault/vault-service.js';
import { exportEncrypted } from './encrypted.js';
import { parseKeyholdJson } from './keyhold-json.js';
import { bareRecord, buildDocument, NOW, richRecord } from './test-fixtures.js';

/**
 * The encrypted parcel's tests.
 *
 * There is deliberately nothing here that tests the cryptography: AES-GCM, Argon2id, the
 * envelope and the container each have their own tests, and re-asserting them from a fourth
 * place would only create a second opinion about what correct looks like. What is tested here
 * is the *composition* — that the right document goes in, the right bytes come out, and
 * nothing rides along that the caller did not select.
 *
 * The KDF is pinned to the floor rather than the shipped defaults. These tests derive a key
 * several times and the cost parameters are not what is under test; the floor is still a real
 * Argon2id derivation, so the code path is the same one production takes.
 *
 * Fault injections performed against this file, reverted:
 *
 *  1. The attachment filter replaced with `[...supplied]`, so a parcel carried every chunk in
 *     the vault. 1 failed — "carries only the chunks belonging to the selected records",
 *     which is the disclosure this format exists to avoid.
 *
 * Three of the injections listed in `keyhold-json.test.ts` also fail tests in this file,
 * because the parcel's payload is the same serialiser. That overlap is deliberate: it is what
 * makes "the parcel really does carry the whole document" an assertion rather than an
 * assumption.
 */

/** Argon2 at the OWASP floor. Fast enough for a test, and still the production code path. */
const KDF = {
  memoryKib: MIN_KDF_PARAMS.memoryKib,
  iterations: MIN_KDF_PARAMS.iterations,
  parallelism: MIN_KDF_PARAMS.parallelism,
} as const;

const PASSPHRASE = 'a passphrase for the parcel, not the vault';

function chunk(id: string, byte: number): AttachmentChunk {
  return { id, data: new Uint8Array([byte, byte, byte]) };
}

async function open(
  bytes: Uint8Array,
  password = PASSPHRASE
): Promise<{ body: Uint8Array; attachments: readonly AttachmentChunk[] }> {
  const { header } = readPreamble(bytes);
  const keys = await unlock(password, header.kdf, header.wrappedDek);
  try {
    const contents = readContainer(bytes, keys.dek);
    return { body: contents.body, attachments: contents.attachments };
  } finally {
    keys.dek.destroy();
  }
}

describe('round trip', () => {
  it('decrypts back to the document it was given', async () => {
    const document = buildDocument([richRecord(), bareRecord()]);
    const exported = await exportEncrypted(document, { password: PASSPHRASE, now: NOW, kdf: KDF });

    const { body } = await open(exported.bytes);
    expect(parseKeyholdJson(body).document).toEqual(document);
  });

  it('opens as an ordinary vault body too, which is what makes a parcel unlockable', async () => {
    const document = buildDocument([richRecord()]);
    const exported = await exportEncrypted(document, { password: PASSPHRASE, now: NOW, kdf: KDF });

    const { body } = await open(exported.bytes);
    expect(parseVaultDocument(body).records.map((record) => record.id)).toEqual(['rec-1']);
  });

  it('is not readable with the wrong passphrase', async () => {
    const exported = await exportEncrypted(buildDocument([bareRecord()]), {
      password: PASSPHRASE,
      now: NOW,
      kdf: KDF,
    });

    await expect(open(exported.bytes, 'not it')).rejects.toMatchObject({
      code: 'WRONG_PASSWORD',
    });
  });

  it('refuses a parcel whose body has been altered', async () => {
    const exported = await exportEncrypted(buildDocument([bareRecord()]), {
      password: PASSPHRASE,
      now: NOW,
      kdf: KDF,
    });

    const tampered = Uint8Array.from(exported.bytes);
    // Well past the header, inside the sealed body. Flipping a bit must break the tag.
    const target = tampered.length - 40;
    tampered[target] = (tampered[target] ?? 0) ^ 0xff;

    await expect(open(tampered)).rejects.toBeInstanceOf(VaultError);
  });
});

describe('the result', () => {
  it('says its bytes are not readable, and offers no warning to show', async () => {
    const exported = await exportEncrypted(buildDocument([bareRecord()]), {
      password: PASSPHRASE,
      now: NOW,
      kdf: KDF,
    });

    expect(exported.containsSecrets).toBe(false);
    expect(exported.warning).toBeNull();
    expect(exported.extension).toBe('.keepx');
  });

  it('excludes trashed records by default, like every other format', async () => {
    const document = buildDocument([
      bareRecord({ id: 'live' }),
      bareRecord({ id: 'binned', trashedAt: NOW - 5 }),
    ]);
    const exported = await exportEncrypted(document, { password: PASSPHRASE, now: NOW, kdf: KDF });

    const { body } = await open(exported.bytes);
    expect(parseKeyholdJson(body).document.records.map((r) => r.id)).toEqual(['live']);
    expect(exported.recordCount).toBe(1);
  });
});

describe('non-determinism, on purpose', () => {
  it('produces different bytes each time while sealing identical content', async () => {
    const document = buildDocument([bareRecord()]);
    const options = { password: PASSPHRASE, now: NOW, kdf: KDF } as const;

    const first = await exportEncrypted(document, options);
    const second = await exportEncrypted(document, options);

    // A deterministic ciphertext would mean a reused salt, a reused key and a reused nonce.
    // In GCM that leaks the XOR of the two plaintexts and enables forgery, so identical bytes
    // here would be a serious bug rather than a nice property.
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(false);

    const firstBody = (await open(first.bytes)).body;
    const secondBody = (await open(second.bytes)).body;
    expect(Buffer.from(firstBody).equals(Buffer.from(secondBody))).toBe(true);
  });
});

describe('attachments', () => {
  const mine = '0123456789abcdef0123456789abcdef';
  const theirs = 'fedcba9876543210fedcba9876543210';

  const document = buildDocument([
    richRecord(),
    {
      ...bareRecord({ id: 'other' }),
      attachments: [
        {
          id: theirs,
          name: 'other.pdf',
          mime: 'application/pdf',
          size: 3,
          sha256: 'b'.repeat(64),
          addedAt: NOW,
        },
      ],
    },
  ]);

  it('carries only the chunks belonging to the selected records', async () => {
    const exported = await exportEncrypted(document, {
      password: PASSPHRASE,
      now: NOW,
      kdf: KDF,
      recordIds: ['rec-1'],
      attachments: [chunk(mine, 1), chunk(theirs, 2)],
    });

    const { attachments } = await open(exported.bytes);
    // A parcel of one record must not carry the file attached to another. The recipient
    // would have no way to know it was in there, and the sender no way to see they sent it.
    expect(attachments.map((entry) => entry.id)).toEqual([mine]);
  });

  it('reports a chunk it was not given rather than dropping it quietly', async () => {
    const exported = await exportEncrypted(document, {
      password: PASSPHRASE,
      now: NOW,
      kdf: KDF,
      recordIds: ['rec-1'],
    });

    const loss = exported.losses.find((entry) => entry.field === 'attachment contents');
    expect(loss?.kind).toBe('dropped');
    expect(loss?.records).toBe(1);
  });
});
