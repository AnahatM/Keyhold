// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * A copy of the vault kept somewhere else, refreshed after every save.
 *
 * Backlog C6. The rolling `.keepbak` files beside the vault protect against a bad write; they
 * do nothing about the drive failing, the folder being deleted, or the laptop being stolen.
 * This is the other half: a second location the user picks — an external drive, a network
 * share, a synced folder — that gets the same bytes.
 *
 * ## The bytes are already encrypted, which is the entire reason this is safe to offer
 *
 * A `.keep` is a sealed container. Copying one to a USB stick or a company file share reveals
 * nothing that leaving it on the disk did not, so there is no consent screen here and no
 * warning: this is a file copy of a file that is already safe to copy. That would not be true
 * of any of the plaintext exports, which is why none of them can be scheduled.
 *
 * ## Written atomically, and never in place
 *
 * The mirror is written to a temp name in the destination and renamed over the previous copy.
 * A copy interrupted half-way — the drive pulled out, the share dropping — would otherwise
 * leave a truncated file where the user's only off-machine copy used to be, which is worse
 * than having no mirror at all.
 *
 * ## A failure here never fails a save
 *
 * The destination is removable, remote, or both. It is unplugged, it is full, it needs a
 * password the user has not typed today. None of that may stop a credential being saved to
 * the vault that *is* present — so every failure is caught, recorded and reported, and the
 * save it followed is already complete by the time this runs.
 */

/** Kept beside the mirror, so a failed copy never overwrites the last good one. */
const TEMP_SUFFIX = '.mirrortmp';

export interface MirrorSettings {
  /** Absolute path to the **folder** the copy goes in. `null` disables mirroring. */
  readonly directory: string | null;
  /** How many dated copies to keep there. 1 means only the newest. */
  readonly keep: number;
}

export const DEFAULT_MIRROR_SETTINGS: MirrorSettings = { directory: null, keep: 3 };

export interface MirrorResult {
  readonly status: 'written' | 'disabled' | 'failed';
  /** The basename written, when one was. Never a directory — see the report rules. */
  readonly fileName: string | null;
  /** Why it failed, in words a user can act on. `null` on success. */
  readonly problem: string | null;
  readonly at: number;
}

/**
 * The name a mirrored copy takes.
 *
 * Dated rather than a single overwritten file, because a mirror that only ever holds the
 * newest save is no protection against the failure people actually have: noticing a mistake
 * a day later. `keep` bounds how many are held.
 *
 * The date is local and to the minute. Two saves in the same minute produce the same name and
 * the second replaces the first, which is the intent — a mirror is not an audit trail.
 */
export function mirrorNameFor(vaultPath: string, at: number): string {
  const when = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = [
    when.getFullYear(),
    pad(when.getMonth() + 1),
    pad(when.getDate()),
    '-',
    pad(when.getHours()),
    pad(when.getMinutes()),
  ].join('');
  return `${basename(vaultPath)}.${stamp}.mirror`;
}

export interface MirrorInput {
  readonly vaultPath: string;
  readonly settings: MirrorSettings;
  readonly at: number;
}

export async function mirrorVault(input: MirrorInput): Promise<MirrorResult> {
  const { directory, keep } = input.settings;
  if (directory === null || directory === '') {
    return { status: 'disabled', fileName: null, problem: null, at: input.at };
  }

  const fileName = mirrorNameFor(input.vaultPath, input.at);
  const target = join(directory, fileName);
  const temp = `${target}${TEMP_SUFFIX}`;

  try {
    if (dirname(input.vaultPath) === directory) {
      // Refused rather than allowed to succeed uselessly. A "backup" in the folder that is
      // already lost when the folder is lost protects against nothing, and somebody who set
      // it here believes they have an off-machine copy.
      throw new Error('the copy is set to the folder the vault is already in');
    }

    await mkdir(directory, { recursive: true });
    await copyFile(input.vaultPath, temp);
    await rename(temp, target);
    await prune(directory, input.vaultPath, keep);

    return { status: 'written', fileName, problem: null, at: input.at };
  } catch (error) {
    // The temp is removed on the way out so a failed run leaves nothing behind. Its own
    // failure is ignored: there is nothing useful to do about it and the real problem is
    // the one being reported.
    await rm(temp, { force: true }).catch(() => undefined);
    return {
      status: 'failed',
      fileName: null,
      problem: describe(error),
      at: input.at,
    };
  }
}

/**
 * Drops the oldest copies past `keep`.
 *
 * Sorted by name rather than by mtime, and the name is what makes that correct: the stamp is
 * `YYYYMMDD-HHMM`, so lexical order **is** chronological order. Reading mtimes would be a
 * stat per file on what may be a network share, and a copied file's mtime is whatever the
 * destination filesystem decided to record.
 */
async function prune(directory: string, vaultPath: string, keep: number): Promise<void> {
  if (keep <= 0) return;

  const prefix = `${basename(vaultPath)}.`;
  const names = (await readdir(directory))
    .filter((name) => name.startsWith(prefix) && name.endsWith('.mirror'))
    .sort();

  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    // One failure must not stop the rest: a locked file on a share is common, and leaving
    // one extra copy behind is a far better outcome than aborting the prune.
    await rm(join(directory, name), { force: true }).catch(() => undefined);
  }
}

/** Whether a directory can be written to, for the settings screen to check before saving. */
export async function mirrorDestinationProblem(directory: string): Promise<string | null> {
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) return 'That path is a file, not a folder.';
    return null;
  } catch {
    return 'That folder could not be reached. If it is on a drive or a share, connect it first.';
  }
}

/**
 * A failure in words, with **no path in it**.
 *
 * Node's errors carry the full path, and this string is shown on screen and written into the
 * activity log. A network share's path names a server and often a person; it is not something
 * to put where a screenshot will catch it.
 */
function describe(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (code === 'ENOENT') return 'The folder could not be found. Connect the drive and try again.';
  if (code === 'EACCES' || code === 'EPERM') return 'Keyhold is not allowed to write there.';
  if (code === 'ENOSPC') return 'There is no space left in that folder.';
  if (error instanceof Error && !error.message.includes('\\') && !error.message.includes('/')) {
    return error.message;
  }
  return 'The copy could not be written.';
}
