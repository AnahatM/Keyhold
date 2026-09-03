// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The main-process half of `.keeptheme`.
 *
 * The format itself lives in `@shared/theme/keeptheme.js` because both processes need to
 * agree on what a theme is; this barrel is the file, dialog, projection and IPC layer that
 * `src/main/ipc/register.ts` and `src/main/index.ts` call.
 *
 * `register.ts` needs exactly one of these — `createThemeIpcHandlers` — and `main/index.ts`
 * needs two: `openedThemes` and `notifyThemeFileOpened`.
 */

export {
  readKeepThemeFile,
  writeKeepThemeFile,
  themeDirectoryOf,
  THEME_TEMP_SUFFIX,
  type ThemeFileReadFailure,
  type ThemeFileReadResult,
  type ThemeFileWriteResult,
} from './keeptheme-file.js';

export { chooseKeepThemeToOpen, chooseKeepThemeDestination } from './theme-dialogs.js';

export {
  importKeepTheme,
  prepareKeepThemeExport,
  type ThemeExportPreparation,
  type ThemeImportOutcome,
  type ThemeFileFailure,
} from './theme-service.js';

export { projectParseResult, projectRejection, projectWarnings } from './theme-projection.js';

export {
  createThemeIpcHandlers,
  type ThemeIpcContext,
  type ThemeIpcHandlers,
} from './theme-ipc.js';

export { notifyThemeFileOpened, openedThemes, OpenedThemeStore } from './opened-themes.js';
