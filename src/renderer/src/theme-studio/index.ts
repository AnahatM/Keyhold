// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The theme studio.
 *
 * A barrel because the host mounts one component and should not have to know which of the
 * seven files inside here defines it. Everything else — the draft reducer, the token
 * grouping, the file transport — is internal to the screen.
 */

export { ThemeStudio, type ThemeStudioProps } from './ThemeStudio.js';
