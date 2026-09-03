// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unlock as unlockKeys } from '../crypto/envelope.js';
import { VaultError } from '../crypto/errors.js';
import { keyholdJsonParser } from '../import/keyhold-json.js';
import { readVaultFile } from '../vault/atomic-write.js';
import { VaultService } from '../vault/vault-service.js';
import { readVaultAsImportSource } from './vault-source.js';

/**
 * Importing another Keyhold vault.
 *
 * The decision (D30) is that a `.keep` is a Keyhold JSON document in a different envelope, so
 * importing one is decrypt, re-serialise, and hand to the parser that already exists. These
 * tests are about the two things that claim can get wrong:
 *
 *  - **The passphrase actually gates it.** A decrypt path that accepted anything would pass
 *    every "it imported" assertion, so the wrong-passphrase case is the one that gives the
 *    right-passphrase case its meaning.
 *  - **What comes out really is what the existing parser reads.** If it were not, the "one
 *    mapping" argument would be false and there would be a second, drifting mapping hidden in
 *    the serialise step.
 */

let dir: string;
let vaultPath: string;
let seeder: VaultService;

const PASSPHRASE = 'the-other-vaults-master-password';
const FAST_KDF = { memoryKib: 19_456, iterations: 2, parallelism: 1 } as const;

/** A vault on disk with two records, standing in for somebody else's. */
async function seedOtherVault(): Promise<void> {
  await seeder.createVault({ path: vaultPath, password: PASSPHRASE, kdf: FAST_KDF });
  seeder.createCredential({
    title: 'Their Bank',
    username: 'them@example.com',
    password: 'their-password',
    urls: ['https://bank.example'],
  });
  seeder.createCredential({ title: 'Their Note', notes: 'kept in the safe' });
  await seeder.save();
  seeder.lock();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keyhold-vault-import-'));
  vaultPath = join(dir, 'theirs.keep');
  seeder = new VaultService('other-device');
});

afterEach(async () => {
  seeder.lock();
  await rm(dir, { recursive: true, force: true });
});

describe('opening another vault as a source', () => {
  it('produces something the existing Keyhold JSON parser reads', async () => {
    await seedOtherVault();

    const source = await readVaultAsImportSource({
      fileName: 'theirs.keep',
      bytes: await readVaultFile(vaultPath),
      secretPassphrase: PASSPHRASE,
    });

    // The whole D30 argument in one assertion: no second mapping, because the output is
    // exactly the format the importer already knows. If this ever stops being true, the
    // "one mapping" claim is false and a second one is hiding in the serialise step.
    const text = Buffer.from(source.bytes).toString('utf8');
    expect(keyholdJsonParser.detect(text)).toBe(true);

    const result = keyholdJsonParser.parse(text);
    expect(result.records.map((record) => record.title).sort()).toEqual([
      'Their Bank',
      'Their Note',
    ]);
    expect(result.records.find((record) => record.title === 'Their Bank')?.password).toBe(
      'their-password'
    );
  });

  it('refuses the wrong passphrase, which is what makes the first test mean anything', async () => {
    await seedOtherVault();

    await expect(
      readVaultAsImportSource({
        fileName: 'theirs.keep',
        bytes: await readVaultFile(vaultPath),
        secretPassphrase: 'not-their-password',
      })
    ).rejects.toBeInstanceOf(VaultError);
  });

  it('refuses a file that is not a vault at all', async () => {
    await expect(
      readVaultAsImportSource({
        fileName: 'notes.txt',
        bytes: new TextEncoder().encode('this is not a keep file'),
        secretPassphrase: PASSPHRASE,
      })
    ).rejects.toBeInstanceOf(VaultError);
  });

  it('keeps the file name the user picked', async () => {
    await seedOtherVault();

    // The wizard's first screen names the file. Inventing one here would show the user a name
    // they never saw in the dialog they just used.
    const source = await readVaultAsImportSource({
      fileName: 'theirs.keep',
      bytes: await readVaultFile(vaultPath),
      secretPassphrase: PASSPHRASE,
    });
    expect(source.fileName).toBe('theirs.keep');
  });

  it('never puts the passphrase in what it returns', async () => {
    await seedOtherVault();

    const source = await readVaultAsImportSource({
      fileName: 'theirs.keep',
      bytes: await readVaultFile(vaultPath),
      secretPassphrase: PASSPHRASE,
    });

    // The passphrase is the one thing here that is not already in the vault. It is used once
    // and must appear nowhere in the result — not in the bytes, not in the name.
    expect(Buffer.from(source.bytes).toString('utf8')).not.toContain(PASSPHRASE);
    expect(source.fileName).not.toContain(PASSPHRASE);
  });

  it('destroys the data key on the way out, on the happy path', async () => {
    await seedOtherVault();

    // Observed through an injected unlock, which exists for exactly this. `SecretBytes` is
    // live key material for another person's vault, and holding it after the one read it was
    // needed for is the definition of keeping a key around too long.
    let captured: { destroyed: boolean } | null = null;
    await readVaultAsImportSource({
      fileName: 'theirs.keep',
      bytes: await readVaultFile(vaultPath),
      secretPassphrase: PASSPHRASE,
      unlock: async (password, params, wrapped) => {
        const keys = await unlockKeys(password, params, wrapped);
        captured = keys.dek;
        return keys;
      },
    });

    expect(captured).not.toBeNull();
    expect((captured as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });

  it('destroys it on the failing path too, which is where it would be forgotten', async () => {
    await seedOtherVault();

    // A malformed body is exactly when a `destroy()` at the end of the happy path never runs.
    // The bytes are truncated after the header so the unlock succeeds and the read does not.
    const bytes = await readVaultFile(vaultPath);
    let captured: { destroyed: boolean } | null = null;

    await readVaultAsImportSource({
      fileName: 'theirs.keep',
      bytes: bytes.subarray(0, bytes.length - 200),
      secretPassphrase: PASSPHRASE,
      unlock: async (password, params, wrapped) => {
        const keys = await unlockKeys(password, params, wrapped);
        captured = keys.dek;
        return keys;
      },
    }).catch(() => undefined);

    expect(captured).not.toBeNull();
    expect((captured as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });

  it('never puts the passphrase in the error for a wrong one', async () => {
    await seedOtherVault();

    // The message reaches a banner and a bug report. `WRONG_PASSWORD`'s wording is the crypto
    // layer's and says what to do; what it must never do is quote what was typed.
    const error = await readVaultAsImportSource({
      fileName: 'theirs.keep',
      bytes: await readVaultFile(vaultPath),
      secretPassphrase: 'a-very-distinctive-wrong-passphrase',
    }).catch((thrown: unknown) => thrown);

    expect(String(error)).not.toContain('a-very-distinctive-wrong-passphrase');
  });
});
