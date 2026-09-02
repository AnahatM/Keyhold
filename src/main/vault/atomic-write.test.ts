// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_ID } from '@shared/format/types.js';
import { createVaultKeys } from '../crypto/envelope.js';
import { randomBytes, uuid } from '../crypto/random.js';
import { writeContainer } from '../format/container.js';
import { newHeader } from '../format/header.js';
import {
  backupPathFor,
  findOrphanedTemp,
  listBackups,
  quarantineOrphanedTemp,
  readVaultFile,
  tempPathFor,
  writeVaultFileAtomically,
} from './atomic-write.js';

/**
 * These tests exist for goal G1: never lose a credential.
 *
 * Every scenario below is a real way people lose vault files — an interrupted save, a
 * full disk, a crash between writing and renaming. The property that matters is not
 * "the happy path works" but "**a complete, valid vault exists at some path at every
 * instant**", including in the middle of a failed write.
 */

let dir: string;
let vaultPath: string;

const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));
const read = async (path: string): Promise<string> => (await readFile(path)).toString('utf8');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keyhold-test-'));
  vaultPath = join(dir, 'test.keep');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('atomic writing', () => {
  it('creates the file and its parent directory', async () => {
    const nested = join(dir, 'a', 'b', 'nested.keep');
    await writeVaultFileAtomically(nested, utf8('v1'));
    expect(await read(nested)).toBe('v1');
  });

  it('leaves no temp file behind on success', async () => {
    await writeVaultFileAtomically(vaultPath, utf8('v1'));
    await expect(stat(tempPathFor(vaultPath))).rejects.toThrow();
    expect(await findOrphanedTemp(vaultPath)).toBeNull();
  });

  it('replaces the previous contents completely', async () => {
    await writeVaultFileAtomically(vaultPath, utf8('a much longer first version'));
    await writeVaultFileAtomically(vaultPath, utf8('short'));

    // A naive in-place write would leave trailing bytes of the longer original here.
    expect(await read(vaultPath)).toBe('short');
  });

  it('round-trips binary data without corruption', async () => {
    const bytes = randomBytes(64 * 1024);
    await writeVaultFileAtomically(vaultPath, bytes);
    expect(await readVaultFile(vaultPath)).toEqual(bytes);
  });

  it('writes a real vault that still opens afterwards', async () => {
    const params = {
      alg: KDF_ID,
      memoryKib: 19_456,
      iterations: 2,
      parallelism: 1,
      salt: Buffer.from(randomBytes(16)).toString('base64'),
    } as const;
    const { keys, wrappedDek } = await createVaultKeys('master', params);
    const header = newHeader({ vaultId: uuid(), deviceId: uuid(), kdf: params, wrappedDek });
    const bytes = writeContainer(
      header,
      { body: utf8('{"records":[]}'), attachments: [] },
      keys.dek
    );

    await writeVaultFileAtomically(vaultPath, bytes);
    expect(await readVaultFile(vaultPath)).toEqual(bytes);
  });
});

describe('rolling backups', () => {
  it('does not create a backup for a brand-new vault', async () => {
    const result = await writeVaultFileAtomically(vaultPath, utf8('v1'));
    expect(result.backupPath).toBeNull();
    expect(await listBackups(vaultPath)).toHaveLength(0);
  });

  it('keeps the previous version as .bak.1', async () => {
    await writeVaultFileAtomically(vaultPath, utf8('v1'));
    await writeVaultFileAtomically(vaultPath, utf8('v2'));

    expect(await read(vaultPath)).toBe('v2');
    expect(await read(backupPathFor(vaultPath, 1))).toBe('v1');
  });

  it('shifts older backups down, oldest first out', async () => {
    for (const version of ['v1', 'v2', 'v3', 'v4']) {
      await writeVaultFileAtomically(vaultPath, utf8(version), { backupCount: 3 });
    }

    expect(await read(vaultPath)).toBe('v4');
    expect(await read(backupPathFor(vaultPath, 1))).toBe('v3');
    expect(await read(backupPathFor(vaultPath, 2))).toBe('v2');
    expect(await read(backupPathFor(vaultPath, 3))).toBe('v1');
  });

  it('never keeps more than the configured number of backups', async () => {
    for (let i = 0; i < 12; i += 1) {
      await writeVaultFileAtomically(vaultPath, utf8(`v${i}`), { backupCount: 3 });
    }
    expect(await listBackups(vaultPath)).toHaveLength(3);
  });

  it('can be disabled', async () => {
    await writeVaultFileAtomically(vaultPath, utf8('v1'), { backupCount: 0 });
    await writeVaultFileAtomically(vaultPath, utf8('v2'), { backupCount: 0 });
    expect(await listBackups(vaultPath)).toHaveLength(0);
  });

  it('lists backups with their index and metadata', async () => {
    await writeVaultFileAtomically(vaultPath, utf8('v1'));
    await writeVaultFileAtomically(vaultPath, utf8('v2'));
    await writeVaultFileAtomically(vaultPath, utf8('v3'));

    const backups = await listBackups(vaultPath);
    expect(backups.map((b) => b.index)).toEqual([1, 2]);
    expect(backups[0]?.sizeBytes).toBe(2);
  });

  it('ignores unrelated files that merely share a prefix', async () => {
    await writeVaultFileAtomically(vaultPath, utf8('v1'));
    await writeFile(`${vaultPath}.bak.notanumber`, 'noise');
    await writeFile(`${vaultPath}.bak.0`, 'noise');
    await writeFile(join(dir, 'other.keep.bak.1'), 'a different vault');

    await writeVaultFileAtomically(vaultPath, utf8('v2'));
    const backups = await listBackups(vaultPath);
    expect(backups.map((b) => b.index)).toEqual([1]);
  });
});

describe('crash recovery', () => {
  it('reports a temp file left by an interrupted write', async () => {
    await writeVaultFileAtomically(vaultPath, utf8('the good version'));
    // Exactly what a crash between "write temp" and "rename" leaves behind.
    await writeFile(tempPathFor(vaultPath), 'a half-written save');

    const orphan = await findOrphanedTemp(vaultPath);
    expect(orphan).not.toBeNull();
    expect(orphan?.vaultStillPresent).toBe(true);
    expect(orphan?.sizeBytes).toBe(19);
  });

  it('leaves the live vault untouched when a temp file is present', async () => {
    await writeVaultFileAtomically(vaultPath, utf8('the good version'));
    await writeFile(tempPathFor(vaultPath), 'garbage');

    // The whole point of rename-last: the original is never at risk.
    expect(await read(vaultPath)).toBe('the good version');
  });

  it('quarantines an orphan instead of deleting it', async () => {
    await writeVaultFileAtomically(vaultPath, utf8('live'));
    await writeFile(tempPathFor(vaultPath), 'possibly the newest data');

    const quarantined = await quarantineOrphanedTemp(vaultPath);
    expect(quarantined).toMatch(/\.recovered-/);
    expect(await read(quarantined!)).toBe('possibly the newest data');

    // The temp path is now clear, and the live vault is unchanged.
    expect(await findOrphanedTemp(vaultPath)).toBeNull();
    expect(await read(vaultPath)).toBe('live');
  });

  it('notices an orphan with no live vault at all — the worst case', async () => {
    // A crash during the very first save. There is no original to fall back on, so the
    // temp is the only copy in existence and must never be silently discarded.
    await writeFile(tempPathFor(vaultPath), 'the only copy that exists');

    const orphan = await findOrphanedTemp(vaultPath);
    expect(orphan?.vaultStillPresent).toBe(false);

    const quarantined = await quarantineOrphanedTemp(vaultPath);
    expect(await read(quarantined!)).toBe('the only copy that exists');
  });

  it('reports no orphan when there is none', async () => {
    await writeVaultFileAtomically(vaultPath, utf8('v1'));
    expect(await findOrphanedTemp(vaultPath)).toBeNull();
    expect(await quarantineOrphanedTemp(vaultPath)).toBeNull();
  });
});

describe('failure handling', () => {
  it('leaves the original vault intact when the write fails', async () => {
    await writeVaultFileAtomically(vaultPath, utf8('the good version'));

    // A directory sitting where the temp file needs to go makes `open` fail — a stand-in
    // for a full disk or a permissions problem, both of which surface the same way.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(tempPathFor(vaultPath));

    await expect(writeVaultFileAtomically(vaultPath, utf8('v2'))).rejects.toThrow();
    expect(await read(vaultPath)).toBe('the good version');
  });

  it('does not rotate backups when the write never reaches the rename', async () => {
    await writeVaultFileAtomically(vaultPath, utf8('v1'));
    await writeVaultFileAtomically(vaultPath, utf8('v2'));
    const backupsBefore = await listBackups(vaultPath);

    const { mkdir } = await import('node:fs/promises');
    await mkdir(tempPathFor(vaultPath));
    await expect(writeVaultFileAtomically(vaultPath, utf8('v3'))).rejects.toThrow();

    // A failed save must not consume a backup slot — otherwise repeated failures would
    // quietly age out every good copy the user has.
    expect(await listBackups(vaultPath)).toEqual(backupsBefore);
    expect(await read(vaultPath)).toBe('v2');
  });
});
