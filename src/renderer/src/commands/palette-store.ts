// SPDX-License-Identifier: GPL-3.0-or-later

import { create } from 'zustand';
import type { Platform } from '@shared/ipc/api.js';

/**
 * Which overlay is open, and what platform we are on.
 *
 * A store rather than component state because three separate things need the answer — the
 * key handler (to know an overlay owns the keyboard), the palette, and the help sheet,
 * which the palette can itself open. Threading two booleans through props would put the
 * `open` state of the help sheet in a component that has nothing else to do with it.
 *
 * ## The platform is fetched once, ever
 *
 * `window.keyhold.app.getPlatform()` is a promise across IPC. Calling it per render, or per
 * shortcut label, would be an IPC round trip to draw a `⌘`. It is fetched once into this
 * store, and `loadPlatform` is idempotent so a second mount is free.
 *
 * It starts `null` and the UI renders **no shortcut label at all** until it resolves,
 * rather than defaulting to `win32` and showing a Mac user `Ctrl+K` for the frame before
 * the answer lands. A missing hint is a cosmetic gap; a wrong hint is a lie about a key
 * that does not work, and the user has no way to know which one they were shown.
 */

interface PaletteState {
  readonly paletteOpen: boolean;
  readonly helpOpen: boolean;
  /** `null` until the main process answers. See the file header. */
  readonly platform: Platform | null;

  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  openHelp: () => void;
  closeHelp: () => void;
  setPlatform: (platform: Platform) => void;
}

export const usePaletteStore = create<PaletteState>((set) => ({
  paletteOpen: false,
  helpOpen: false,
  platform: null,

  openPalette: () => {
    set({ paletteOpen: true });
  },
  closePalette: () => {
    set({ paletteOpen: false });
  },
  togglePalette: () => {
    set((state) => ({ paletteOpen: !state.paletteOpen }));
  },
  openHelp: () => {
    // The palette closes: two stacked native dialogs both take the top layer, and the one
    // underneath is inert but still painted, which reads as a rendering bug.
    set({ helpOpen: true, paletteOpen: false });
  },
  closeHelp: () => {
    set({ helpOpen: false });
  },
  setPlatform: (platform) => {
    set({ platform });
  },
}));

/**
 * Opens the palette from outside React — a toolbar button, a menu item.
 *
 * A plain function rather than a hook, so a caller that is not a component (or does not
 * want to subscribe to the store just to open it) has a way in that does not involve
 * reaching into `getState()` at the call site.
 */
export function openCommandPalette(): void {
  usePaletteStore.getState().openPalette();
}

/** Whether any overlay this module owns is up. The key handler's `overlayOpen`. */
export function anyOverlayOpen(state: {
  readonly paletteOpen: boolean;
  readonly helpOpen: boolean;
}): boolean {
  return state.paletteOpen || state.helpOpen;
}

let platformRequest: Promise<void> | null = null;

/**
 * Asks the main process what platform this is, once per window.
 *
 * The memo is the whole point: `React.StrictMode` double-invokes effects in development,
 * and every mount of the provider would otherwise be another IPC call for a value that
 * cannot change while the app is running.
 *
 * A failure is swallowed to `null`. If the bridge is unavailable the app has larger
 * problems than a missing `⌘`, and a rejected promise here would surface as an unhandled
 * rejection in a component that only wanted to draw a label.
 */
export function loadPlatform(): Promise<void> {
  platformRequest ??= window.keyhold.app
    .getPlatform()
    .then((platform) => {
      usePaletteStore.getState().setPlatform(platform);
    })
    .catch(() => {
      // Deliberately silent — see above.
    });
  return platformRequest;
}
