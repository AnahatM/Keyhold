// SPDX-License-Identifier: GPL-3.0-or-later
import { basename } from 'node:path';
import {
  parseKeepTheme,
  serialiseKeepTheme,
  type KeepTheme,
  type KeepThemeParseResult,
  type KeepThemeRejection,
} from '@shared/theme/keeptheme.js';
import { readKeepThemeFile, type ThemeFileReadFailure } from './keeptheme-file.js';

/**
 * Importing and exporting a `.keeptheme`, composed from the pure format and the file layer.
 *
 * No Electron here on purpose — `theme-dialogs.ts` owns that — so this whole path can be
 * exercised against real files in a test without an app instance.
 *
 * ## This is the only route a `.keeptheme` takes
 *
 * The studio used to move theme files itself, with an `<input type="file">` and an
 * `<a download>`, on the argument that a theme holds no secret material so the renderer may
 * as well. That transport is gone. `THEME_CHANNELS` in `@shared/theme/theme-channels.js`
 * records the full argument; the short version is that a save dialog is an act of consent
 * only the main process can obtain, that an `<a download>` is not one, and that a file
 * arriving from a stranger should be parsed on the side of the boundary that already holds
 * the keys rather than the side that draws the screen.
 *
 * A theme is still not *secret*, and nothing here treats it as though it were — the size cap
 * is enforced by `stat` before a byte is read, and the parse is `parseKeepTheme`, the same
 * function everything else uses.
 */

export interface ThemeImportOutcome {
  readonly result: KeepThemeParseResult;
  /** The file's own name, for "imported from …" copy. Never the full path. */
  readonly fileName: string;
}

/**
 * A file that could not be read at all, as distinct from one that could not be parsed.
 *
 * Carries `readKeepThemeFile`'s own code rather than only its message. The caller has to map
 * this onto a `ThemeErrorCode`, and doing that by matching words in a human-readable
 * sentence is a mapping that silently becomes wrong the day someone improves the copy.
 */
export interface ThemeFileFailure {
  readonly ok: false;
  readonly code: ThemeFileReadFailure;
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
  if (!read.ok) return { ok: false, code: read.code, message: read.message };

  return {
    result: parseKeepTheme(read.contents, { acknowledgement }),
    // Only the basename crosses back. A full path in a UI string is a small, free
    // information leak that also ends up in screenshots people post in bug reports.
    fileName: basename(path),
  };
}

export type ThemeExportPreparation =
  | { readonly ok: true; readonly contents: string; readonly theme: KeepTheme }
  | { readonly ok: false; readonly rejection: KeepThemeRejection };

/**
 * Serialises a theme and verifies it is one this app would accept back.
 *
 * The round trip through `parseKeepTheme` is the point: the export is *verified* to be
 * importable rather than assumed to be. A file this app cannot read back is not an export,
 * and finding that out on write is far better than finding it out when someone hands the
 * file to a friend.
 *
 * Separated from the write so the caller can check **before** opening a save dialog. Asking
 * someone to name a file and pick a folder and only then telling them the theme is
 * unexportable is a small cruelty, and it leaves a dialog's worth of state to unwind.
 */
export function prepareKeepThemeExport(
  theme: KeepTheme,
  acknowledgement: string | null = null
): ThemeExportPreparation {
  const contents = serialiseKeepTheme(theme);
  const verified = parseKeepTheme(contents, { acknowledgement });

  if (!verified.ok) return { ok: false, rejection: verified.rejection };
  // The re-parsed theme, not the argument: canonicalised, and with anything the caller
  // attached that is not part of the format already dropped.
  return { ok: true, contents, theme: verified.theme };
}
