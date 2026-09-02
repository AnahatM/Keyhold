// SPDX-License-Identifier: GPL-3.0-or-later
import { open, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { KEEPTHEME_MAX_BYTES } from '@shared/theme/keeptheme.js';

/**
 * Reading and writing `.keeptheme` files on disk.
 *
 * Deliberately separate from `keeptheme.ts`, which is pure and knows nothing about a
 * filesystem, and from `theme-dialogs.ts`, which is the only file here that needs Electron.
 * The split is what lets the format and this module be tested without an app instance.
 *
 * ## Why this does not reuse `writeVaultFileAtomically`
 *
 * That function is the vault's, and it does three vault-specific things: it rotates
 * `.keepbak` backups, it creates files `0o600`, and it quarantines orphaned temps on the
 * next launch. All three are wrong for a theme. A theme is meant to be readable by the
 * user's other tools and shared with other people, so `0o600` would be actively unhelpful;
 * rolling backups of a colour file are clutter; and an orphaned theme temp is not a
 * data-loss event worth a recovery path. What is worth keeping is the ordering —
 * write, fsync, rename — so a crash mid-write cannot leave a half-written theme where a
 * whole one used to be.
 */

export const THEME_TEMP_SUFFIX = '.tmp';

export type ThemeFileReadResult =
  | { readonly ok: true; readonly contents: string }
  | {
      readonly ok: false;
      readonly code: 'too-large' | 'not-a-file' | 'unreadable';
      readonly message: string;
    };

/**
 * Reads a theme file, refusing anything implausible before it is loaded into memory.
 *
 * The size is checked with `stat` first: a `.keeptheme` is about 1.5 KB, and reading a
 * multi-gigabyte file into a string to discover it is not a theme is a denial of service a
 * user can hand themselves by mis-picking a file in a dialog.
 */
export async function readKeepThemeFile(path: string): Promise<ThemeFileReadResult> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return { ok: false, code: 'not-a-file', message: 'That is not a file.' };
    }
    size = info.size;
  } catch {
    // Deliberately not echoing the OS error: it carries the absolute path, and an error
    // string is one of the places a path should never end up (hard rule 1's shape).
    return { ok: false, code: 'unreadable', message: 'That file could not be opened.' };
  }

  if (size > KEEPTHEME_MAX_BYTES) {
    return {
      ok: false,
      code: 'too-large',
      message: `A theme file cannot be larger than ${KEEPTHEME_MAX_BYTES / 1024} KB.`,
    };
  }

  let handle;
  try {
    handle = await open(path, 'r');
    const raw = await handle.readFile('utf8');
    // A BOM is what Notepad and PowerShell's `>` produce, and `JSON.parse` refuses it.
    // Stripping it here means "I edited my theme in Notepad" is not a bug report.
    return { ok: true, contents: raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw };
  } catch {
    return { ok: false, code: 'unreadable', message: 'That file could not be read.' };
  } finally {
    await handle?.close();
  }
}

export type ThemeFileWriteResult =
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string };

/**
 * Writes a theme durably: temp file, fsync, rename over the target.
 *
 * The rename is the atomic step. Without it, a crash between opening the destination and
 * finishing the write leaves a truncated file with the right name, which imports as "not
 * valid JSON" and looks like the app corrupted the user's work.
 */
export async function writeKeepThemeFile(
  path: string,
  contents: string
): Promise<ThemeFileWriteResult> {
  const tempPath = `${path}${THEME_TEMP_SUFFIX}`;

  // Declared without an initialiser: both arms of the try/catch below assign it, so a
  // starting value would only ever be the one nobody reads.
  let written: boolean;
  let handle;
  try {
    handle = await open(tempPath, 'w');
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    written = true;
  } catch {
    written = false;
  } finally {
    // Closed before the temp is removed: on Windows an open handle makes the unlink fail,
    // which would leave the debris this branch exists to clear.
    await handle?.close();
  }

  if (!written) {
    await rm(tempPath, { force: true });
    return { ok: false, message: 'That theme could not be written.' };
  }

  try {
    await rename(tempPath, path);
    return { ok: true, path };
  } catch {
    // The rename failed, so anything already at `path` is untouched. Clear the temp so it
    // is not left beside the user's themes looking like debris.
    await rm(tempPath, { force: true });
    return { ok: false, message: 'That theme could not be saved to that location.' };
  }
}

/** The directory a path sits in, for callers that want to remember where the user saved. */
export function themeDirectoryOf(path: string): string {
  return dirname(path);
}
