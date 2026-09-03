// SPDX-License-Identifier: GPL-3.0-or-later
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Durable, owner-only writing for the small JSON files that live beside the app's data.
 *
 * There are two of them — `preferences.json` and `window-state.json` — and both were
 * written with a plain `writeFileSync`, which is wrong in two separate ways.
 *
 * ## The permissions half
 *
 * A default `writeFileSync` creates the file `0o666` less umask. `preferences.json` holds
 * `quickUnlock[].protectedDek`: the data key wrapped by DPAPI or the macOS Keychain. The
 * wrapping is what actually protects it and the file lives in a per-user directory, so this
 * is not a disclosure on its own — but on a POSIX box with a permissive umask it is a
 * world-readable file containing key ciphertext, and `atomic-write.ts` already opens the
 * vault's own temp file `0o600`. Two standards for key material in one codebase is one too
 * many.
 *
 * ## The durability half, which is the more interesting one
 *
 * A truncating in-place write has a window where the file is empty. A crash or a power cut
 * inside it leaves a zero-byte `preferences.json`, and every quick-unlock enrolment and the
 * whole recent-vault list are gone. That is recoverable — the master password always works —
 * but "never lose data" is applied everywhere else in this codebase, and a config file is
 * not exempt just because it is small.
 *
 * So: write a temp, flush it, rename over the target. The rename is atomic on NTFS and
 * APFS, which means a reader either sees the whole old file or the whole new one and never
 * a torn or empty one. This is the same sequence as `vault/atomic-write.ts` minus the
 * rolling backups and the directory fsync — a config file does not warrant either, and the
 * cost of the fsync on every window move would be felt.
 */

/** The mode every file written here gets: owner read/write, nobody else anything. */
export const CONFIG_FILE_MODE = 0o600;

/**
 * Serialises `value` and writes it to `path` atomically, owner-only.
 *
 * Throws what the filesystem throws. Both callers already treat a failed config write as
 * "not worth interrupting anyone over" and swallow it; that decision stays theirs.
 */
export function writeJsonFileSync(path: string, value: unknown): void {
  const temp = join(dirname(path), `.${basename(path)}.tmp`);
  const json = JSON.stringify(value, null, 2);

  let handle: number | undefined;
  try {
    handle = openSync(temp, 'w', CONFIG_FILE_MODE);
    writeSync(handle, json, 0, 'utf8');
    // Flush before the rename. Without this the rename can land while the bytes are still
    // in cache, which on some filesystems yields an empty file after a crash — the exact
    // outcome this function exists to prevent.
    fsyncSync(handle);
  } catch (error) {
    if (handle !== undefined) closeSync(handle);
    handle = undefined;
    // Leave no temp behind to be mistaken for a real file later.
    rmSync(temp, { force: true });
    throw error;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }

  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
