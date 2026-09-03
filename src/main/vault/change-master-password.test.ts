// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeepHeader } from '@shared/format/types.js';
import { unlock as unlockKeys } from '../crypto/envelope.js';
import { VaultError } from '../crypto/errors.js';
import type { UnlockedVaultKeys } from '../crypto/envelope.js';
import { readPreamble } from '../format/container.js';
import { readVaultFile } from './atomic-write.js';
import { VaultService } from './vault-service.js';

/**
 * Changing the master password, and re-keying the KDF.
 *
 * This is the one operation that rewrites the header of a vault already holding real data,
 * so the properties worth pinning are not "does it run" but:
 *
 *  - **the DEK survives** — the body is re-sealed, never re-encrypted under a new key. If
 *    that ever stops being true the operation silently becomes O(vault size) and gains a
 *    window in which a crash loses everything.
 *  - **a failure leaves the old password working.** Every rejection path below is checked by
 *    reopening the file with the ORIGINAL password, because "it threw" is not the same as
 *    "it changed nothing", and the difference between them is a vault nobody can open.
 */

let dir: string;
let vaultPath: string;
let service: VaultService;

const OLD_PASSWORD = 'the-original-master-password';
const NEW_PASSWORD = 'a-different-master-password-entirely';

/** The OWASP floor. Argon2 is slow by design and this file is not testing its strength. */
const FAST_KDF = { memoryKib: 19_456, iterations: 2, parallelism: 1 } as const;

/** Creates a vault holding one saved record, and returns that record's id. */
async function seed(): Promise<string> {
  await service.createVault({ path: vaultPath, password: OLD_PASSWORD, kdf: FAST_KDF });
  const created = service.createCredential({
    title: 'Survives the change',
    username: 'someone',
    password: 'the-record-password',
  });
  await service.save();
  return created.id;
}

/** The header as it currently sits on disk — plaintext, so no password is needed. */
async function headerFromDisk(): Promise<KeepHeader> {
  return readPreamble(await readVaultFile(vaultPath)).header;
}

/** The DEK the file's header currently wraps, unwrapped with `password`. */
async function dekFromDisk(password: string): Promise<UnlockedVaultKeys> {
  const header = await headerFromDisk();
  return unlockKeys(password, header.kdf, header.wrappedDek);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keyhold-rekey-'));
  vaultPath = join(dir, 'test.keep');
  service = new VaultService('test-device');
});

afterEach(async () => {
  service.lock();
  await rm(dir, { recursive: true, force: true });
});

describe('changing the master password', () => {
  it('makes the new password open the vault and the old one stop working', async () => {
    await seed();
    await service.changeMasterPassword({
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    service.lock();

    await expect(service.unlock(vaultPath, OLD_PASSWORD)).rejects.toBeInstanceOf(VaultError);
    await expect(service.unlock(vaultPath, NEW_PASSWORD)).resolves.toBeDefined();
  });

  it('keeps the vault contents, because the body is re-sealed and not re-encrypted', async () => {
    const id = await seed();
    await service.changeMasterPassword({
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    service.lock();

    await service.unlock(vaultPath, NEW_PASSWORD);
    expect(service.getProjection(id)?.title).toBe('Survives the change');
  });

  // The load-bearing property. If the DEK changed, every record and every attachment chunk
  // would have to be re-encrypted, and this test is what stops that regression landing
  // unnoticed behind an operation that still appears to work.
  it('re-wraps the same DEK rather than generating a new one', async () => {
    await seed();
    const before = await dekFromDisk(OLD_PASSWORD);

    await service.changeMasterPassword({
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    const after = await dekFromDisk(NEW_PASSWORD);
    expect(after.dek.equals(before.dek)).toBe(true);
    before.dek.destroy();
    after.dek.destroy();
  });

  it('draws a fresh salt, so two passwords for one vault never share one', async () => {
    await seed();
    const before = (await headerFromDisk()).kdf.salt;

    await service.changeMasterPassword({
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect((await headerFromDisk()).kdf.salt).not.toBe(before);
  });

  it('rejects a wrong current password and leaves the old one working', async () => {
    await seed();

    await expect(
      service.changeMasterPassword({
        currentPassword: 'not-the-current-password',
        newPassword: NEW_PASSWORD,
      })
    ).rejects.toBeInstanceOf(VaultError);

    service.lock();
    await expect(service.unlock(vaultPath, OLD_PASSWORD)).resolves.toBeDefined();
  });

  it('does not touch the file at all when the current password is wrong', async () => {
    await seed();
    const before = await stat(vaultPath);

    await expect(
      service.changeMasterPassword({
        currentPassword: 'not-the-current-password',
        newPassword: NEW_PASSWORD,
      })
    ).rejects.toBeInstanceOf(VaultError);

    // Unchanged size and mtime: the check runs before anything is generated, so there is no
    // write to roll back and no backup rotation to explain to the user.
    const after = await stat(vaultPath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  // The rollback branch. Discovered by fault injection: deleting the `catch` that restores
  // the header failed nothing, because every other test here reaches a save that succeeds.
  //
  // The failure it guards is the nastiest one this operation has. The header is swapped into
  // memory *before* the save, because `#saveOnce` seals the body against it. If the save then
  // fails and the swap stands, the file on disk still wants the OLD password while the
  // session holds a header describing the NEW one — and the next successful save, from any
  // ordinary edit, writes that header out. The user is then locked out by a password change
  // they were told had failed.
  it('puts the old header back when the save fails, so the old password still opens it', async () => {
    await seed();

    // The write guard is the one seam that can fail a save without corrupting anything: it
    // runs before `writeVaultFileAtomically`, so nothing has touched the file.
    service.setWriteGuard(() => {
      throw new Error('disk went away');
    });
    await expect(
      service.changeMasterPassword({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
      })
    ).rejects.toThrow('disk went away');
    service.setWriteGuard(null);

    // The important half: an ordinary save afterwards must not carry the abandoned header to
    // disk. Without the rollback this save succeeds and silently commits the new password.
    service.createCredential({ title: 'An edit after the failure' });
    await service.save();

    service.lock();
    await expect(service.unlock(vaultPath, NEW_PASSWORD)).rejects.toBeInstanceOf(VaultError);
    await expect(service.unlock(vaultPath, OLD_PASSWORD)).resolves.toBeDefined();
  });
});

describe('re-keying the KDF', () => {
  it('keeps the existing cost when none is given', async () => {
    await seed();
    await service.changeMasterPassword({
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    // Changing a password must not silently change how long every future unlock takes.
    const header = await headerFromDisk();
    expect(header.kdf.iterations).toBe(FAST_KDF.iterations);
    expect(header.kdf.memoryKib).toBe(FAST_KDF.memoryKib);
  });

  it('raises the cost when asked, and the vault still opens', async () => {
    await seed();
    await service.changeMasterPassword({
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
      kdf: { iterations: 3 },
    });

    expect((await headerFromDisk()).kdf.iterations).toBe(3);
    service.lock();
    await expect(service.unlock(vaultPath, NEW_PASSWORD)).resolves.toBeDefined();
  });

  it('re-keys without changing the password, when both are the same', async () => {
    await seed();
    await service.changeMasterPassword({
      currentPassword: OLD_PASSWORD,
      newPassword: OLD_PASSWORD,
      kdf: { iterations: 3 },
    });

    service.lock();
    await expect(service.unlock(vaultPath, OLD_PASSWORD)).resolves.toBeDefined();
    expect((await headerFromDisk()).kdf.iterations).toBe(3);
  });

  it('refuses a cost below the OWASP floor and leaves the vault as it was', async () => {
    await seed();

    await expect(
      service.changeMasterPassword({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        kdf: { memoryKib: 8 },
      })
    ).rejects.toBeInstanceOf(VaultError);

    service.lock();
    await expect(service.unlock(vaultPath, OLD_PASSWORD)).resolves.toBeDefined();
  });
});

describe('the floor, inherited rather than restated', () => {
  // The floor lives in `deriveKey`, the single place a key is derived, so every path that
  // takes a password inherits it — `createVault`, `unlock`, and the re-key above. These
  // check that inheritance rather than a second copy of the check: an earlier draft of this
  // slice added `assertUsableKdfParams` to `createVault`, and deleting it again failed
  // nothing, which is how the duplicate was caught. Settings is about to hand the cost field
  // to users, so the behaviour is worth pinning even though the check is elsewhere.
  it('refuses to create a vault below the OWASP floor', async () => {
    await expect(
      service.createVault({ path: vaultPath, password: OLD_PASSWORD, kdf: { memoryKib: 8 } })
    ).rejects.toBeInstanceOf(VaultError);
  });

  it('refuses a cost so large it would be a denial of service', async () => {
    await expect(
      service.createVault({
        path: vaultPath,
        password: OLD_PASSWORD,
        kdf: { memoryKib: 68_719_476_736 },
      })
    ).rejects.toBeInstanceOf(VaultError);
  });
});
