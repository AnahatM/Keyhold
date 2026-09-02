// SPDX-License-Identifier: GPL-3.0-or-later
import { basename } from 'node:path';
import {
  parseKeepTheme,
  serialiseKeepTheme,
  type KeepTheme,
  type KeepThemeParseResult,
} from '@shared/theme/keeptheme.js';
import { readKeepThemeFile, writeKeepThemeFile } from './keeptheme-file.js';

/**
 * Importing and exporting a `.keeptheme`, composed from the pure format and the file layer.
 *
 * No Electron here on purpose — `theme-dialogs.ts` owns that — so this whole path can be
 * exercised against real files in a test without an app instance.
 *
 * ## Why a theme is the one file the renderer may also handle itself
 *
 * Everything else in Keyhold goes through the main process because the main process owns
 * the keys and the decrypted vault (decision D13). A `.keeptheme` is the exception, and it
 * is worth stating why rather than leaving it to look like an inconsistency: it contains no
 * secret material, it is not encrypted, and it is meant to be shared. The renderer's own
 * `<input type="file">` path in `theme-studio/theme-file-bridge.ts` is therefore safe —
 * and it runs the identical `parseKeepTheme`, so validation cannot differ between the two
 * routes. This module exists so the native-dialog route is available once the IPC
 * namespace is wired, and so the size cap is enforced by `stat` before a file is read.
 */

export interface ThemeImportOutcome {
  readonly result: KeepThemeParseResult;
  /** The file's own name, for "imported from …" copy. Never the full path. */
  readonly fileName: string;
}

export interface ThemeFileFailure {
  readonly ok: false;
  readonly message: string;
}

/**
 * Reads and parses a theme file.
 *
 * `acknowledgement` is the token from `contrastAcknowledgement`, echoed back by a caller
 * that has shown the user the failing pairs. Passing nothing leaves a failing theme
 * rejected, which is the intended default.
 */
export async function importKeepTheme(
  path: string,
  acknowledgement: string | null = null
): Promise<ThemeImportOutcome | ThemeFileFailure> {
  const read = await readKeepThemeFile(path);
  if (!read.ok) return { ok: false, message: read.message };

  return {
    result: parseKeepTheme(read.contents, { acknowledgement }),
    // Only the basename crosses back. A full path in a UI string is a small, free
    // information leak that also ends up in screenshots people post in bug reports.
    fileName: basename(path),
  };
}

/**
 * Serialises and writes a theme.
 *
 * The theme is round-tripped through `parseKeepTheme` before it is written — the export is
 * verified to be importable rather than assumed to be. A file this app cannot read back is
 * not an export, and finding that out on write is far better than finding it out when
 * someone hands the file to a friend.
 */
export async function exportKeepTheme(
  path: string,
  theme: KeepTheme,
  acknowledgement: string | null = null
): Promise<{ readonly ok: true; readonly path: string } | ThemeFileFailure> {
  const contents = serialiseKeepTheme(theme);

  const verified = parseKeepTheme(contents, { acknowledgement });
  if (!verified.ok) return { ok: false, message: verified.rejection.message };

  const written = await writeKeepThemeFile(path, contents);
  if (!written.ok) return { ok: false, message: written.message };
  return { ok: true, path: written.path };
}
