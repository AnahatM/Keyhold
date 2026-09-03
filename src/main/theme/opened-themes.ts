// SPDX-License-Identifier: GPL-3.0-or-later
import type { BrowserWindow } from 'electron';
import { THEME_EVENTS } from '@shared/theme/theme-channels.js';

/**
 * The `.keeptheme` the operating system handed us, held until the studio asks for it.
 *
 * `src/main/shell/file-open-request.ts` has always accepted `.keeptheme` — the extension is
 * in `FILE_OPEN_EXTENSIONS` and in `electron-builder.yml`'s `fileAssociations` — and there
 * was nothing on the other end: a double-clicked theme was validated and then dropped. This
 * is the other end.
 *
 * ## Why the path stays here
 *
 * The renderer is never told where the file is, and there is no channel that accepts a path.
 * The `themeTakeOpened` channel takes no argument at all. That is the same rule the vault,
 * attachment, import and export paths follow, and it holds for an OS-supplied path too: the
 * string came from a file manager, a browser download, or another process that got the
 * single-instance lock's `argv`. `parseFileOpenRequest` has already checked it is absolute,
 * local, control-character-free and an existing file — but "validated" is not "chosen by the
 * user in our own dialog", so it is held rather than handed over.
 *
 * ## Why one slot rather than a queue
 *
 * Selecting six themes and opening them at once is not a thing anyone does, and if it were,
 * the studio can only edit one. The newest wins, and an unclaimed older one is dropped: a
 * queue would mean the studio opening a theme the user picked several minutes ago and has
 * forgotten about, which is worse than losing it.
 */
export class OpenedThemeStore {
  #path: string | null = null;

  /** True when something is waiting. For a menu item's enabled state. */
  get hasPending(): boolean {
    return this.#path !== null;
  }

  remember(path: string): void {
    this.#path = path;
  }

  /**
   * Hands over the pending path and clears the slot.
   *
   * Taking rather than reading is deliberate: a theme that has been delivered once must not
   * be re-delivered on the next mount of the studio, or navigating away and back would
   * silently discard whatever the user had been editing.
   */
  take(): string | null {
    const path = this.#path;
    this.#path = null;
    return path;
  }

  clear(): void {
    this.#path = null;
  }
}

/**
 * The app's single store.
 *
 * A module singleton because there is one app, one shell and one window, and threading an
 * instance from `main/index.ts` through `registerIpcHandlers` to reach two call sites would
 * be ceremony around a fact that cannot vary. The class is exported so tests get their own.
 */
export const openedThemes = new OpenedThemeStore();

/**
 * Tells the renderer a theme is waiting.
 *
 * Payload-free on purpose — see `THEME_EVENTS`. The listener's whole job is to call
 * `themeTakeOpened`, so nothing about the file rides on an event that a later edit could
 * widen into a path. Sent through the window rather than broadcast, and a no-op before a
 * window exists: on macOS `open-file` arrives before `whenReady`, and the store keeps the
 * path until the studio asks for it anyway.
 */
export function notifyThemeFileOpened(window: BrowserWindow | null): void {
  if (window === null || window.isDestroyed()) return;
  window.webContents.send(THEME_EVENTS.themeFileOpened);
}
