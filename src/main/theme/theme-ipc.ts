// SPDX-License-Identifier: GPL-3.0-or-later
import { basename } from 'node:path';
import type { BrowserWindow } from 'electron';
import {
  THEME_CHANNELS,
  THEME_ERROR_CODES,
  type ThemeExportResponse,
  type ThemeImportResponse,
} from '@shared/theme/theme-channels.js';
import { requireThemeExportRequest } from '@shared/theme/theme-validation.js';
import { chooseKeepThemeDestination, chooseKeepThemeToOpen } from './theme-dialogs.js';
import { writeKeepThemeFile } from './keeptheme-file.js';
import { openedThemes, type OpenedThemeStore } from './opened-themes.js';
import { projectParseResult, projectRejection } from './theme-projection.js';
import { importKeepTheme, prepareKeepThemeExport } from './theme-service.js';

/**
 * The bodies behind `kh:theme:import`, `kh:theme:export` and `kh:theme:take-opened`.
 *
 * They live here rather than inline in `src/main/ipc/register.ts` for the same reason the
 * import service does: that file is a 1,000-line switchboard, and a handler with three
 * dialog branches and a validation step inside it stops being a switchboard entry. What
 * `register.ts` needs is three lines.
 *
 * ## The shape every handler here follows
 *
 * 1. **Validate the request** before anything touches a disk or opens a window. A malformed
 *    request throws `IpcValidationError`, which `register.ts`'s `toFailure` turns into
 *    `INVALID_REQUEST` — a malformed payload is a bug or an attack and must not proceed on
 *    a guess.
 * 2. **Open the dialog here, in the main process.** No handler accepts a path, in either
 *    direction. A path the renderer chose would be attacker-controlled if the renderer were
 *    ever compromised; a path the user picked in an OS dialog is a genuine act of consent,
 *    and the OS — not us — decides what they were allowed to reach.
 * 3. **Project the result.** Nothing reaches the renderer except through
 *    `theme-projection.ts`, which is where the rule about what a hostile file may put on
 *    screen is written down and tested.
 * 4. **Cancelling is an outcome, not an error.** Dismissing a dialog is the system working,
 *    and reporting it as a failure is how people learn to ignore failures.
 */

export interface ThemeIpcContext {
  readonly getWindow: () => BrowserWindow | null;
  /** Defaults to the app's single store. Injected so tests get their own. */
  readonly openedThemeStore?: OpenedThemeStore | undefined;
}

export interface ThemeIpcHandlers {
  readonly importTheme: () => Promise<ThemeImportResponse>;
  readonly exportTheme: (raw: unknown) => Promise<ThemeExportResponse>;
  readonly takeOpenedTheme: () => Promise<ThemeImportResponse | null>;
}

export function createThemeIpcHandlers(context: ThemeIpcContext): ThemeIpcHandlers {
  const store = context.openedThemeStore ?? openedThemes;

  /**
   * Reads and projects one already-chosen path.
   *
   * Shared by the dialog route and the OS-double-click route so both are parsed and
   * projected identically — a second projection is a second answer to "what may a hostile
   * file show the user", and the two would not stay the same.
   */
  const readAndProject = async (path: string): Promise<ThemeImportResponse> => {
    const imported = await importKeepTheme(path);

    if ('ok' in imported) {
      // A read failure, not a parse one. Its message is written from constants and never
      // carries the path — see `readKeepThemeFile`. `not-a-file` folds into `unreadable`:
      // the renderer has no different answer for a directory than for a permission error,
      // and both messages already say which it was.
      return {
        kind: 'refused',
        code:
          imported.code === 'too-large' ? THEME_ERROR_CODES.tooLarge : THEME_ERROR_CODES.unreadable,
        message: imported.message,
        tokens: [],
      };
    }

    return projectParseResult(imported.result, imported.fileName);
  };

  return {
    importTheme: async (): Promise<ThemeImportResponse> => {
      const path = await chooseKeepThemeToOpen(context.getWindow());
      if (path === null) return { kind: 'cancelled' };
      return readAndProject(path);
    },

    exportTheme: async (raw): Promise<ThemeExportResponse> => {
      const request = requireThemeExportRequest(THEME_CHANNELS.themeExport, raw);

      // Verified before the dialog opens. Asking someone to name a file and pick a folder
      // and only then telling them the theme is unexportable is a small cruelty — and a
      // theme that fails the legibility floor must be refused whichever direction it is
      // travelling, or the app becomes a way to hand an unusable theme to somebody else.
      const prepared = prepareKeepThemeExport(request.theme, request.acknowledgement);
      if (!prepared.ok) return projectRejection(prepared.rejection);

      const path = await chooseKeepThemeDestination(context.getWindow(), prepared.theme.name);
      if (path === null) return { kind: 'cancelled' };

      const written = await writeKeepThemeFile(path, prepared.contents);
      if (!written.ok) {
        return {
          kind: 'refused',
          code: THEME_ERROR_CODES.writeFailed,
          message: written.message,
          tokens: [],
        };
      }

      // Only the basename crosses back. The renderer has no use for the directory, and a
      // full path in a UI string ends up in the screenshots attached to bug reports.
      return { kind: 'saved', fileName: basename(written.path) };
    },

    takeOpenedTheme: async (): Promise<ThemeImportResponse | null> => {
      // `null` rather than `cancelled`: nothing was waiting is not the same as the user
      // dismissed a dialog, and the studio treats them differently — one is silent, the
      // other is too.
      const path = store.take();
      if (path === null) return null;
      return readAndProject(path);
    },
  };
}
