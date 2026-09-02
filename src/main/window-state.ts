// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, screen, type BrowserWindow, type Rectangle } from 'electron';

/**
 * Remembers where the window was, and puts it back there.
 *
 * Trivial-sounding, and consistently one of the things that makes an app feel native or
 * not. The part that is actually easy to get wrong is the restore: a saved position is
 * only valid for the display arrangement it was saved on, and a window restored onto a
 * monitor that has since been unplugged opens **completely off-screen** — the app is
 * running, the taskbar shows it, and there is no window. `isVisibleOnSomeDisplay` below is
 * the whole reason this file is not four lines.
 */

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximised: boolean;
}

const DEFAULT_STATE: WindowState = { width: 1180, height: 760, maximised: false };

/** Below this the three-pane shell has nothing left to collapse. */
const MIN_WIDTH = 720;
const MIN_HEIGHT = 520;

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

export function readWindowState(): WindowState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf8')) as Partial<WindowState>;
    return {
      ...DEFAULT_STATE,
      ...raw,
      width: Math.max(MIN_WIDTH, raw.width ?? DEFAULT_STATE.width),
      height: Math.max(MIN_HEIGHT, raw.height ?? DEFAULT_STATE.height),
      maximised: raw.maximised === true,
    };
  } catch {
    // No file yet, or a corrupted one. Neither is worth surfacing — the app just opens at
    // its default size, which is what a first run does anyway.
    return DEFAULT_STATE;
  }
}

/**
 * True when at least part of `bounds` lands on a display that currently exists.
 *
 * The failure this prevents: someone works on a laptop with an external monitor, closes
 * Keyhold with the window on that monitor, unplugs it, and reopens. Without this check the
 * window is restored to coordinates that no longer correspond to any screen — invisible,
 * unreachable, and indistinguishable from a crash.
 */
function isVisibleOnSomeDisplay(bounds: Rectangle): boolean {
  // A generous overlap: a window peeking a little off the edge is fine and often
  // deliberate. What matters is that enough of it is grabbable.
  const MIN_VISIBLE = 120;

  return screen.getAllDisplays().some(({ workArea }) => {
    const overlapX =
      Math.min(bounds.x + bounds.width, workArea.x + workArea.width) -
      Math.max(bounds.x, workArea.x);
    const overlapY =
      Math.min(bounds.y + bounds.height, workArea.y + workArea.height) -
      Math.max(bounds.y, workArea.y);
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE;
  });
}

/** Window options derived from the saved state, with an off-screen position discarded. */
export function windowOptionsFromState(state: WindowState): {
  width: number;
  height: number;
  x?: number;
  y?: number;
} {
  const base = { width: state.width, height: state.height };

  if (state.x === undefined || state.y === undefined) return base;

  const bounds = { x: state.x, y: state.y, width: state.width, height: state.height };
  // Dropping x and y lets Electron centre the window on the primary display — the right
  // fallback, because "centred" is always reachable.
  return isVisibleOnSomeDisplay(bounds) ? { ...base, x: state.x, y: state.y } : base;
}

/**
 * Saves size and position as the user moves and resizes.
 *
 * Writes are debounced: a resize drag fires hundreds of events, and writing a file on each
 * one would be wasteful and could leave a torn file if the app were killed mid-drag.
 *
 * `getNormalBounds` rather than `getBounds` so a maximised window remembers the size it
 * had *before* being maximised — otherwise un-maximising restores it to full screen and
 * the window can never be made small again.
 */
export function trackWindowState(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;

  const save = (): void => {
    if (window.isDestroyed()) return;
    const bounds = window.getNormalBounds();
    const state: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximised: window.isMaximized(),
    };
    try {
      writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8');
    } catch {
      // Forgetting the window position is not a reason to interrupt anyone.
    }
  };

  const scheduleSave = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };

  window.on('resize', scheduleSave);
  window.on('move', scheduleSave);
  window.on('maximize', scheduleSave);
  window.on('unmaximize', scheduleSave);

  // Synchronous on close: the debounce timer will not survive the window going away, and
  // this is the one moment the state genuinely must be recorded.
  window.on('close', () => {
    if (timer !== undefined) clearTimeout(timer);
    save();
  });
}
