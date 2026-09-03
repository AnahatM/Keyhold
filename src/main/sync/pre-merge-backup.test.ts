// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KDF_ID, type KdfParams, type SealedBox } from '@shared/format/types.js';
import { randomBytes, randomSecret, uuid } from '../crypto/random.js';
import { writeContainer } from '../format/container.js';
import { newHeader } from '../format/header.js';
import { backupPathFor, writeVaultFileAtomically } from '../vault/atomic-write.js';
import {
  isPreMergeBackupPath,
  listPreMergeBackups,
  PRE_MERGE_INFIX,
  PreMergeBackup,
  PreMergeBackupError,
} from './pre-merge-backup.js';
import { MERGE_OPTIONS, doc, record } from './test-fixtures.js';

/**
 * The mandatory pre-merge backup.
 *
 * These tests are about one promise: **a merge that has not been backed up does not run**,
 * and a backup that was reported is one that is actually on the disk and actually readable.
 * Everything else here is in service of those two.
 *
 * They write to a real temp directory rather than a mocked filesystem, because the failures
 * worth catching — a rename that did not land, a copy that a later save rotated away, a write
 * that returned success having written half the bytes — are all failures of the real thing.
 * The injectable io seam is used only where a real fault cannot be provoked portably: a full
 * disk, and a write that silently truncates.
 */

// ── A real KEEP file, without paying for Argon2 ───────────────────────────────
//
// Nothing here ever unlocks a vault, so the key does not have to be derived from a password —
// only the *container* has to be genuine, because `verify` parses its preamble. A random DEK
// and a syntactically valid wrapped key give exactly that, in microseconds rather than the
// hundreds of milliseconds a real KDF costs on every one of these cases.

const FAST_KDF: KdfParams = {
  alg: KDF_ID,
  memoryKib: 19_456,
  iterations: 2,
  parallelism: 1,
  salt: Buffer.from(randomBytes(16)).toString('base64'),
};

const base64 = (length: number): string => Buffer.from(randomBytes(length)).toString('base64');

const fakeWrappedDek = (): SealedBox => ({
  nonce: base64(12),
  ciphertext: base64(32),
  tag: base64(16),
});

function vaultBytes(body: string, generation = 1): Uint8Array {
  const header = {
    ...newHeader({
      vaultId: uuid(),
      deviceId: uuid(),
      kdf: FAST_KDF,
      wrappedDek: fakeWrappedDek(),
    }),
    generation,
  };
  return writeContainer(
    header,
    { body: new Uint8Array(Buffer.from(body, 'utf8')), attachments: [] },
    randomSecret(32)
  );
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const FIXED = Date.parse('2026-09-03T01:44:12.908Z');
const fixedClock = (): number => FIXED;

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

let dir: string;
let vaultPath: string;
let original: Uint8Array;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keyhold-premerge-'));
  vaultPath = join(dir, 'personal.keep');
  original = vaultBytes('the vault as it was before the merge', 7);
  await writeFile(vaultPath, original);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ── The happy path ───────────────────────────────────────────────────────────

describe('a merge that was backed up', () => {
  it('leaves a readable, byte-identical copy and runs the merge', async () => {
    const { backup, result } = await PreMergeBackup.runMerge(
      { vaultPath, now: fixedClock },
      ({ merge }) =>
        merge(
          null,
          doc({ records: [record({ id: 'a' })] }),
          doc({ records: [record({ id: 'b' })] }),
          MERGE_OPTIONS
        )
    );

    // The merge really ran, through the real engine.
    expect(result.document.records.map((r) => r.id).sort()).toEqual(['a', 'b']);

    // The copy is on the disk and is the vault.
    expect(await readFile(backup.path)).toEqual(Buffer.from(original));
    expect(backup.digest).toBe(sha256(original));
    expect(backup.sizeBytes).toBe(original.length);
    expect(backup.generation).toBe(7);
    expect(backup.vaultPath).toBe(vaultPath);
    expect(backup.takenAt).toBe('2026-09-03T01:44:12.908Z');
  });

  it('names the copy for the vault, the moment, and nothing else', async () => {
    const { backup } = await PreMergeBackup.runMerge({ vaultPath, now: fixedClock }, () => null);

    expect(backup.fileName).toMatch(
      /^personal\.keep\.pre-merge-2026-09-03T01-44-12-908Z-[0-9a-f]{8}\.keep$/
    );
    // It ends in the vault's own extension, so the file association opens it.
    expect(backup.fileName.endsWith('.keep')).toBe(true);
    expect(backup.path).toBe(join(dir, backup.fileName));
  });

  it('is still there, and still identical, after the ordinary saves that rotate the rolling backups', async () => {
    const { backup } = await PreMergeBackup.runMerge({ vaultPath, now: fixedClock }, () => null);

    // Six saves: more than the five rolling slots, so the pre-merge state has been rotated
    // clean out of `.bak.1..5`. This is the whole reason this file exists.
    for (let save = 1; save <= 6; save += 1) {
      await writeVaultFileAtomically(vaultPath, vaultBytes(`save ${save}`, 7 + save));
    }

    expect(await fileExists(backupPathFor(vaultPath, 5))).toBe(true);
    for (let slot = 1; slot <= 5; slot += 1) {
      expect(await readFile(backupPathFor(vaultPath, slot))).not.toEqual(Buffer.from(original));
    }

    expect(await readFile(backup.path)).toEqual(Buffer.from(original));
  });

  it('survives a merge that threw, because that is when it is most needed', async () => {
    const boom = PreMergeBackup.runMerge({ vaultPath, now: fixedClock }, () => {
      throw new Error('the resolver blew up');
    });

    await expect(boom).rejects.toThrow('the resolver blew up');

    const found = await listPreMergeBackups(vaultPath);
    expect(found).toHaveLength(1);
    expect(await readFile(found[0]!.path)).toEqual(Buffer.from(original));
  });
});

// ── The merge does not run ───────────────────────────────────────────────────

describe('a merge that could not be backed up does not run', () => {
  it('refuses when the vault cannot be read', async () => {
    const session = vi.fn(() => null);

    await expect(
      PreMergeBackup.runMerge({ vaultPath: join(dir, 'gone.keep') }, session)
    ).rejects.toMatchObject({ name: 'PreMergeBackupError', code: 'vault-unreadable' });

    expect(session).not.toHaveBeenCalled();
  });

  it('refuses when the disk is full', async () => {
    const session = vi.fn(() => null);
    const enospc = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });

    await expect(
      PreMergeBackup.runMerge(
        { vaultPath, io: { writeBackup: () => Promise.reject(enospc) } },
        session
      )
    ).rejects.toMatchObject({ code: 'backup-write-failed' });

    expect(session).not.toHaveBeenCalled();
    expect(await listPreMergeBackups(vaultPath)).toEqual([]);
  });

  it('refuses when the folder refuses the write', async () => {
    const session = vi.fn(() => null);
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

    const refused = PreMergeBackup.runMerge(
      { vaultPath, io: { writeBackup: () => Promise.reject(eacces) } },
      session
    );

    await expect(refused).rejects.toBeInstanceOf(PreMergeBackupError);
    await expect(refused).rejects.toMatchObject({ code: 'backup-write-failed' });
    expect(session).not.toHaveBeenCalled();
  });

  it('refuses when the backup folder cannot exist at all', async () => {
    // A real filesystem fault, no seam: `blocker` is a file, so nothing can be created
    // beneath it. This is the read-only-cloud-folder shape without needing platform ACLs.
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');
    const session = vi.fn(() => null);

    await expect(
      PreMergeBackup.runMerge({ vaultPath, directory: join(blocker, 'backups') }, session)
    ).rejects.toMatchObject({ code: 'backup-write-failed' });

    expect(session).not.toHaveBeenCalled();
  });

  it('carries a basename and never a directory in the error', async () => {
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });

    let error: PreMergeBackupError | null = null;
    try {
      await PreMergeBackup.runMerge(
        { vaultPath, now: fixedClock, io: { writeBackup: () => Promise.reject(eacces) } },
        () => null
      );
    } catch (thrown) {
      error = thrown as PreMergeBackupError;
    }

    expect(error).toBeInstanceOf(PreMergeBackupError);
    expect(error?.fileName).toMatch(/^personal\.keep\.pre-merge-/);
    expect(error?.message).not.toContain(dir);
    expect(error?.message).toContain('Nothing has been changed.');
    expect(error?.cause).toBe(eacces);
  });
});

// ── Verification ─────────────────────────────────────────────────────────────

describe('verification, because "the write call returned" is not evidence', () => {
  it('catches a write that truncated', async () => {
    const session = vi.fn(() => null);

    // A real, really-truncated file: the write lands on the real disk, and the read-back that
    // catches it is the real one. Only the number of bytes is a lie.
    await expect(
      PreMergeBackup.runMerge(
        {
          vaultPath,
          io: {
            writeBackup: async (path, bytes) => {
              await writeFile(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
            },
          },
        },
        session
      )
    ).rejects.toMatchObject({ code: 'backup-unverifiable' });

    expect(session).not.toHaveBeenCalled();
  });

  it('catches a copy that never arrived', async () => {
    const session = vi.fn(() => null);

    await expect(
      PreMergeBackup.runMerge({ vaultPath, io: { writeBackup: () => Promise.resolve() } }, session)
    ).rejects.toMatchObject({ code: 'backup-unverifiable' });

    expect(session).not.toHaveBeenCalled();
  });

  /**
   * These two exist because deleting the digest comparison broke none of the tests above: the
   * truncated file was being caught by `readPreamble`, so the check that looked like it was
   * doing the work was not the one doing it. A preamble says "this is a KEEP file"; only the
   * digest says "this is *your* KEEP file", and the body is not authenticated without the key.
   */
  it('catches a copy that is a valid vault but not this one', async () => {
    const session = vi.fn(() => null);
    const somebodyElses = vaultBytes('a different vault entirely', 3);

    await expect(
      PreMergeBackup.runMerge(
        {
          vaultPath,
          io: {
            writeBackup: async (path) => {
              await writeFile(path, somebodyElses);
            },
          },
        },
        session
      )
    ).rejects.toMatchObject({ code: 'backup-unverifiable' });

    expect(session).not.toHaveBeenCalled();
  });

  it('catches one flipped byte in the body, which a preamble cannot see', async () => {
    const session = vi.fn(() => null);

    await expect(
      PreMergeBackup.runMerge(
        {
          vaultPath,
          io: {
            writeBackup: async (path, bytes) => {
              const corrupted = Uint8Array.from(bytes);
              const last = corrupted.length - 1;
              corrupted[last] = (corrupted[last] ?? 0) ^ 0b0000_0001;
              await writeFile(path, corrupted);
            },
          },
        },
        session
      )
    ).rejects.toMatchObject({ code: 'backup-unverifiable' });

    expect(session).not.toHaveBeenCalled();
  });

  it('refuses to call a copy of something that is not a vault a backup', async () => {
    // The bytes would round-trip perfectly. They are still not a vault, and a backup nobody
    // can open is not a backup — reporting one is the failure this module exists to prevent.
    await writeFile(vaultPath, 'this is not a KEEP container');
    const session = vi.fn(() => null);

    await expect(PreMergeBackup.runMerge({ vaultPath }, session)).rejects.toMatchObject({
      code: 'backup-unverifiable',
    });

    expect(session).not.toHaveBeenCalled();
  });
});

// ── Names ────────────────────────────────────────────────────────────────────

describe('names', () => {
  it('does not collide when two merges run against a stopped clock', async () => {
    const first = await PreMergeBackup.runMerge({ vaultPath, now: fixedClock }, () => null);
    const second = await PreMergeBackup.runMerge({ vaultPath, now: fixedClock }, () => null);

    expect(second.backup.path).not.toBe(first.backup.path);
    expect(first.backup.takenAt).toBe(second.backup.takenAt);

    // Both are on the disk, and both are the vault. A collision would have left one.
    expect(await readFile(first.backup.path)).toEqual(Buffer.from(original));
    expect(await readFile(second.backup.path)).toEqual(Buffer.from(original));
    expect(await listPreMergeBackups(vaultPath)).toHaveLength(2);
  });

  it('recognises its own output, and nothing else', async () => {
    const { backup } = await PreMergeBackup.runMerge({ vaultPath, now: fixedClock }, () => null);

    expect(isPreMergeBackupPath(vaultPath, backup.path)).toBe(true);
    // NTFS and the default APFS configuration are case-insensitive; missing a backup because
    // of a capital letter would miss it on exactly the platforms these files live on.
    expect(isPreMergeBackupPath(vaultPath, backup.path.toUpperCase())).toBe(true);

    expect(isPreMergeBackupPath(vaultPath, vaultPath)).toBe(false);
    expect(isPreMergeBackupPath(vaultPath, backupPathFor(vaultPath, 1))).toBe(false);
    expect(isPreMergeBackupPath(vaultPath, `${vaultPath}.tmp`)).toBe(false);
    expect(isPreMergeBackupPath(vaultPath, join(dir, `other.keep${PRE_MERGE_INFIX}x.keep`))).toBe(
      false
    );
  });

  it('lists them newest first, with the moment parsed back out of the name', async () => {
    let tick = FIXED;
    const advancing = (): number => (tick += 1000);

    const first = await PreMergeBackup.runMerge({ vaultPath, now: advancing }, () => null);
    const second = await PreMergeBackup.runMerge({ vaultPath, now: advancing }, () => null);

    const found = await listPreMergeBackups(vaultPath);
    expect(found.map((f) => f.path)).toEqual([second.backup.path, first.backup.path]);
    expect(found[0]?.takenAt).toBe(second.backup.takenAt);
    expect(found[0]?.sizeBytes).toBe(original.length);
  });
});

// ── Retention, the setting ───────────────────────────────────────────────────

describe('retention', () => {
  it('keeps every backup by default', async () => {
    let tick = FIXED;
    const advancing = (): number => (tick += 1000);

    for (let run = 0; run < 4; run += 1) {
      await PreMergeBackup.runMerge({ vaultPath, now: advancing }, () => null);
    }

    expect(await listPreMergeBackups(vaultPath)).toHaveLength(4);
  });

  it('keeps the newest N when the user asks for a limit, and never the one just taken', async () => {
    let tick = FIXED;
    const advancing = (): number => (tick += 1000);

    const taken: string[] = [];
    for (let run = 0; run < 4; run += 1) {
      const { backup } = await PreMergeBackup.runMerge(
        { vaultPath, now: advancing, retain: 2 },
        () => null
      );
      taken.push(backup.path);
      expect(await fileExists(backup.path)).toBe(true);
    }

    const found = await listPreMergeBackups(vaultPath);
    expect(found.map((f) => f.path)).toEqual([taken[3], taken[2]]);
  });
});

// ── The mandate itself ───────────────────────────────────────────────────────

describe('a merge that has not been backed up cannot be expressed', () => {
  /**
   * These are compile-time assertions, and they are the point of the whole design — a
   * `@ts-expect-error` that stops being an error fails `npm run typecheck`, so removing the
   * private field or loosening the constructor breaks the build rather than quietly turning
   * the mandate back into a convention.
   */
  it('will not let a receipt be written by hand', () => {
    // @ts-expect-error — a plain object is not assignable to a class with a private field.
    // This is the forgery the `#digest` field exists to prevent.
    const forged: PreMergeBackup = {
      vaultPath,
      path: join(dir, 'anything.keep'),
      fileName: 'anything.keep',
      takenAt: '2026-09-03T01:44:12.908Z',
      sizeBytes: 0,
      generation: 7,
      digest: 'not a digest',
    };

    expect(forged).toBeDefined();
  });

  it('will not let a receipt be constructed', () => {
    const construct = (): void => {
      // Every field is present and correctly typed, deliberately: the *only* thing wrong with
      // this line must be the privacy, or the directive would be satisfied by an argument
      // error and would go on passing after someone made the constructor public. (It did,
      // until an injection caught it.) Never called — the assertion is that it does not
      // compile.
      // @ts-expect-error — the constructor is private, so the only mint is `runMerge`, which
      // does not return until a verified copy is on the disk.
      new PreMergeBackup({
        vaultPath,
        path: join(dir, 'anything.keep'),
        takenAt: '2026-09-03T01:44:12.908Z',
        sizeBytes: 0,
        generation: 7,
        digest: 'not a digest',
      });
    };

    expect(construct).toBeInstanceOf(Function);
  });

  it('hands the merge out only inside a session', async () => {
    const seen: unknown[] = [];

    const { backup } = await PreMergeBackup.runMerge({ vaultPath, now: fixedClock }, (session) => {
      seen.push(session.merge);
      // The session's backup is the receipt the caller is handed back — one merge, one copy,
      // however many times the engine runs inside the resolver loop.
      expect(session.backup).toBeInstanceOf(PreMergeBackup);
      return session.merge(null, doc(), doc(), MERGE_OPTIONS);
    });

    expect(seen).toHaveLength(1);
    expect(await fileExists(backup.path)).toBe(true);
  });
});
