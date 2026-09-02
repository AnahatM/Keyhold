// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The main-process half of `.keeptheme`.
 *
 * The format itself lives in `@shared/theme/keeptheme.js` because both processes validate
 * with it; this barrel is only the file and dialog layer that the IPC handlers call.
 */

export {
  readKeepThemeFile,
  writeKeepThemeFile,
  themeDirectoryOf,
  THEME_TEMP_SUFFIX,
  type ThemeFileReadResult,
  type ThemeFileWriteResult,
} from './keeptheme-file.js';

export { chooseKeepThemeToOpen, chooseKeepThemeDestination } from './theme-dialogs.js';

export {
  importKeepTheme,
  exportKeepTheme,
  type ThemeImportOutcome,
  type ThemeFileFailure,
} from './theme-service.js';
