// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Types for `make-icons.mjs`, which is plain JavaScript on purpose.
 *
 * The script runs before anything is compiled — it is a build step, not application code —
 * so it stays a `.mjs` that Node executes directly. This file is what lets its guard test
 * import it without `any` leaking through the whole suite, which is the alternative and the
 * reason six lint errors appeared the first time.
 */

/** Every file the icon set consists of, keyed by its path under `build/`. */
export function buildIcons(): Map<string, Buffer>;

/** The sizes the Windows `.ico` carries, smallest first. */
export const ICO_SIZES: readonly number[];

/** The macOS OSTypes and the pixel size each one means. */
export const ICNS_ENTRIES: readonly (readonly [string, number])[];

/** The standalone PNG sizes, for Linux packaging and for documents. */
export const PNG_SIZES: readonly number[];
