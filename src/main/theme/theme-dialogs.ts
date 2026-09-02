// SPDX-License-Identifier: GPL-3.0-or-later
import { basename } from 'node:path';
import {
  dialog,
  type BrowserWindow,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import { KEEPTHEME_EXTENSION, suggestKeepThemeFileName } from '@shared/theme/keeptheme.js';

/**
 * The native file dialogs for `.keeptheme`.
 *
 * The only file in `src/main/theme` that touches Electron, so everything else here stays
 * testable without an app instance.
 *
 * Dialogs are opened by the MAIN process and never handed a renderer-supplied path — the
 * same rule as the vault dialogs in `ipc/register.ts`, for the same reason: a path the
 * renderer chose would be attacker-controlled if the renderer were ever compromised,
 * whereas a path the user picked in an OS dialog is a genuine act of consent, and the OS
 * decides what they were allowed to reach.
 */

const THEME_FILTER = { name: 'Keyhold theme', extensions: [KEEPTHEME_EXTENSION] };

export async function chooseKeepThemeToOpen(window: BrowserWindow | null): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Import a Keyhold theme',
    filters: [THEME_FILTER, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  };

  // `showOpenDialog` has separate overloads with and without a parent, so the branch is
  // real rather than a null-check formality: a parented dialog is modal and cannot be lost
  // behind the app window.
  const result =
    window === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options);

  return result.canceled ? null : (result.filePaths[0] ?? null);
}

export async function chooseKeepThemeDestination(
  window: BrowserWindow | null,
  themeName: string
): Promise<string | null> {
  const options: SaveDialogOptions = {
    title: 'Export this theme',
    // `basename` because the suggestion is derived from a user-supplied theme name, and a
    // name is not a path — even after slugging, it never gets to choose a directory.
    defaultPath: basename(suggestKeepThemeFileName(themeName)),
    filters: [THEME_FILTER],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };

  const result =
    window === null
      ? await dialog.showSaveDialog(options)
      : await dialog.showSaveDialog(window, options);

  return result.canceled || result.filePath === '' ? null : result.filePath;
}
