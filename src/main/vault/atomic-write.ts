// SPDX-License-Identifier: GPL-3.0-or-later
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Durable, crash-safe vault writing.
 *
 * Goal G1 is "never lose a credential", and the single most likely way to lose all of
 * them at once is a partial write: the process dies, the power goes, or the disk fills
 * halfway through saving, and what is left on disk is a truncated file that will never
 * open again. Writing in place makes that outcome reachable on every single save.
 *
 * The sequence here makes it unreachable:
 *
 *   1. write the new bytes to `vault.keep.tmp`
 *   2. `fsync` the temp file — the bytes are on the platter, not just in a cache
 *   3. rotate `vault.keep` into `vault.keep.bak.1`, shifting older backups down
 *   4. `rename` the temp over `vault.keep` — atomic on both NTFS and APFS
 *   5. `fsync` the containing directory, so the rename itself is durable
 *
 * At every instant, a complete valid vault exists at some path. A crash between 1 and 4
 * leaves the original untouched and an orphaned temp file, which `findOrphanedTemp`
 * surfaces on next launch rather than silently deleting — the temp may hold the newest
 * data, and that decision belongs to the user.
 *
 * Step 5 is the one people skip. Without it a rename can be reordered after a crash on
 * some filesystems, which is precisely the case this whole file exists to prevent.
 */

export const TEMP_SUFFIX = '.tmp';
export const BACKUP_INFIX = '.bak';

export interface WriteOptions {
  /** How many rolling backups to keep. 0 disables backups entirely. */
  readonly backupCount?: number;
}

const DEFAULT_BACKUP_COUNT = 5;

export function tempPathFor(vaultPath: string): string {
  return `${vaultPath}${TEMP_SUFFIX}`;
}

export function backupPathFor(vaultPath: string, index: number): string {
  return `${vaultPath}${BACKUP_INFIX}.${index}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Flushes a directory entry to disk.
 *
 * Windows cannot open a directory as a file, so this is a no-op there — NTFS provides
 * the ordering guarantee we need without it. On macOS it is load-bearing: without it the
 * rename can still be lost on power failure even though the file contents were synced.
 */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    // A filesystem that refuses to sync a directory is not a reason to fail the save —
    // the data is already durable at this point; only the rename's ordering is at stake.
  } finally {
    await handle?.close();
  }
}

/**
 * Shifts `vault.keep.bak.N-1` → `.bak.N`, then copies the current vault to `.bak.1`.
 *
 * The current vault is **copied**, not moved. Moving it would leave a window in which no
 * file exists at the vault's own path, and a crash there would look to the user exactly
 * like the app deleted their passwords.
 */
async function rotateBackups(vaultPath: string, backupCount: number): Promise<void> {
  if (backupCount <= 0) return;
  if (!(await exists(vaultPath))) return;

  const oldest = backupPathFor(vaultPath, backupCount);
  if (await exists(oldest)) await rm(oldest, { force: true });

  for (let index = backupCount - 1; index >= 1; index -= 1) {
    const from = backupPathFor(vaultPath, index);
    if (await exists(from)) await rename(from, backupPathFor(vaultPath, index + 1));
  }

  await copyFile(vaultPath, backupPathFor(vaultPath, 1));
}

/**
 * Writes `bytes` to `vaultPath` durably, keeping rolling backups of the previous version.
 *
 * Returns the paths that now exist, so a caller can report what it did without guessing.
 */
export async function writeVaultFileAtomically(
  vaultPath: string,
  bytes: Uint8Array,
  options: WriteOptions = {}
): Promise<{ vaultPath: string; backupPath: string | null }> {
  const backupCount = options.backupCount ?? DEFAULT_BACKUP_COUNT;
  const directory = dirname(vaultPath);
  const tempPath = tempPathFor(vaultPath);

  await mkdir(directory, { recursive: true });

  // 1 & 2 — write and flush the new bytes.
  let handle;
  try {
    handle = await open(tempPath, 'w', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }

  try {
    // 3 — preserve the version we are about to replace.
    const hadPrevious = await exists(vaultPath);
    await rotateBackups(vaultPath, backupCount);

    // 4 — the atomic swap.
    await rename(tempPath, vaultPath);

    // 5 — make the rename itself durable.
    await syncDirectory(directory);

    return {
      vaultPath,
      backupPath: hadPrevious && backupCount > 0 ? backupPathFor(vaultPath, 1) : null,
    };
  } catch (error) {
    // The rename failed, so the original is still intact. Clear the temp so it is not
    // mistaken for a crashed write on next launch.
    await rm(tempPath, { force: true });
    throw error;
  }
}

export interface OrphanedTemp {
  readonly tempPath: string;
  readonly sizeBytes: number;
  readonly modifiedAt: Date;
  /** True when a live vault also exists — the normal, non-alarming case. */
  readonly vaultStillPresent: boolean;
}

/**
 * Reports a temp file left behind by an interrupted write.
 *
 * Deliberately reports rather than acts. The temp file may be a truncated fragment, or it
 * may be the newest complete copy of the user's vault; nothing here can tell the
 * difference without the master password, and guessing wrong in one direction loses data
 * while guessing wrong in the other resurrects a broken file. So it is surfaced, and the
 * user chooses.
 */
export async function findOrphanedTemp(vaultPath: string): Promise<OrphanedTemp | null> {
  const tempPath = tempPathFor(vaultPath);
  try {
    const info = await stat(tempPath);
    return {
      tempPath,
      sizeBytes: info.size,
      modifiedAt: info.mtime,
      vaultStillPresent: await exists(vaultPath),
    };
  } catch {
    return null;
  }
}

/**
 * Moves an orphaned temp somewhere safe and permanent, so the user can inspect it.
 *
 * Never deletes. Whatever it contains, it is the only copy of something, and disk space
 * is cheaper than a lost password.
 */
export async function quarantineOrphanedTemp(vaultPath: string): Promise<string | null> {
  const orphan = await findOrphanedTemp(vaultPath);
  if (orphan === null) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = `${vaultPath}.recovered-${stamp}`;
  await rename(orphan.tempPath, destination);
  return destination;
}

export async function readVaultFile(vaultPath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(vaultPath));
}

export interface BackupInfo {
  readonly path: string;
  readonly index: number;
  readonly sizeBytes: number;
  readonly modifiedAt: Date;
}

/** Lists existing backups, newest first. */
export async function listBackups(vaultPath: string): Promise<BackupInfo[]> {
  const directory = dirname(vaultPath);
  const prefix = `${basename(vaultPath)}${BACKUP_INFIX}.`;

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const backups: BackupInfo[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;

    const index = Number.parseInt(entry.slice(prefix.length), 10);
    if (!Number.isInteger(index) || index < 1) continue;

    const path = join(directory, entry);
    try {
      const info = await stat(path);
      backups.push({ path, index, sizeBytes: info.size, modifiedAt: info.mtime });
    } catch {
      // Vanished between readdir and stat. Not an error worth surfacing.
    }
  }

  return backups.sort((a, b) => a.index - b.index);
}
