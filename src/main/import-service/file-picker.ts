// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';
import { PARSERS } from '../import/index.js';
import type { PickedImportFile } from './source-store.js';

/**
 * Where the file comes from.
 *
 * An interface, so the import service never reaches for Electron and every one of its tests
 * runs without a window, a dialog, or a file on disk. The real implementation is the only
 * thing in this folder that touches either, and it is deliberately the only thing in this
 * folder that a test never loads.
 */
export interface ImportFilePicker {
  /** `null` when the user dismissed the dialog. */
  pick: () => Promise<PickedImportFile | null>;
}

/**
 * The native dialog, opened by the **main process**.
 *
 * Same rule as `chooseVaultToOpen`, and it matters more here rather than less: a path the
 * renderer supplied would be attacker-controlled if the renderer were ever compromised, and
 * this path is handed to `readFile` in a process that holds the master key. A path the user
 * picked in an OS dialog is a genuine act of consent, and the OS — not us — decides what
 * they were allowed to reach.
 *
 * The path is read here and **never returned**. What comes back is a basename and bytes; the
 * directory is of no use to the wizard, and a full path is the kind of thing that ends up in
 * a screenshot attached to a bug report.
 */
export function createElectronImportFilePicker(
  getWindow: () => BrowserWindow | null
): ImportFilePicker {
  return {
    pick: async (): Promise<PickedImportFile | null> => {
      // The filter list is derived from the format registry rather than typed out, so a
      // twelfth parser bringing a new extension is picked up here for free (rule 8).
      const extensions = [...new Set(PARSERS.flatMap((parser) => parser.extensions))]
        .map((extension) => extension.replace(/^\./, ''))
        .sort();

      const options: OpenDialogOptions = {
        title: 'Choose a file to import',
        filters: [
          { name: 'Password exports', extensions },
          { name: 'All files', extensions: ['*'] },
        ],
        properties: ['openFile'],
      };

      // `showOpenDialog` has separate overloads with and without a parent, so the branch is
      // real rather than a null-check formality — a parented dialog is modal and cannot be
      // lost behind the app window.
      const window = getWindow();
      const result =
        window === null
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(window, options);

      const path = result.canceled ? null : (result.filePaths[0] ?? null);
      if (path === null) return null;

      return { fileName: basename(path), bytes: new Uint8Array(await readFile(path)) };
    },
  };
}
