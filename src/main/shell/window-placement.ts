// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Deciding whether a remembered window position is still a real place.
 *
 * The failure is invisible and indistinguishable from a crash: someone works on a laptop
 * with an external monitor, closes Keyhold with the window on that monitor, unplugs it, and
 * reopens. The saved coordinates no longer correspond to any screen. The process is running,
 * the taskbar shows it, and there is no window to click.
 *
 * `src/main/window-state.ts` already guards the **launch** path and is tested for it. This
 * file is the same rule extracted as a pure function over an injected display list, for two
 * reasons:
 *
 * 1. **The tray reopens the same trap later.** Close-to-tray means the window can sit
 *    hidden for hours while a dock is disconnected. The launch-time check ran before any of
 *    that happened; showing the window again needs the check re-run against the displays
 *    that exist *now*, which is a case `window-state.ts` has no hook for.
 * 2. It is testable without `electron`. `window-state.ts` reaches `screen.getAllDisplays()`
 *    directly and its test has to mock the `electron` module to say anything at all.
 *
 * Per hard rule 8 this is intended to become **the** implementation, with `window-state.ts`
 * delegating to it rather than keeping a second copy of the overlap arithmetic — the exact
 * edit is in the report, since that file is outside this agent's write scope.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The one field of an Electron `Display` this needs. Narrow, so a test can build one. */
export interface DisplayLike {
  readonly workArea: Rect;
}

/**
 * How much of the window must land on a real display for the position to be trusted.
 *
 * Generous on purpose: a window peeking a little off the edge is normal and often
 * deliberate. What matters is that enough of it is grabbable with a pointer — roughly a
 * title bar's worth in each axis.
 */
export const MIN_VISIBLE_PX = 120;

/** Overlap between two rectangles, per axis. Negative when they do not meet. */
function overlap(a: Rect, b: Rect): { x: number; y: number } {
  return {
    x: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    y: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/** True when at least `MIN_VISIBLE_PX` of `bounds` lands on some current display. */
export function isVisibleOnSomeDisplay(bounds: Rect, displays: readonly DisplayLike[]): boolean {
  return displays.some((display) => {
    const { x, y } = overlap(bounds, display.workArea);
    return x >= MIN_VISIBLE_PX && y >= MIN_VISIBLE_PX;
  });
}

export interface WindowPlacement {
  readonly width: number;
  readonly height: number;
  /** Absent when the saved position was discarded — Electron then centres the window. */
  readonly x?: number | undefined;
  readonly y?: number | undefined;
}

export interface SavedPlacement {
  readonly width: number;
  readonly height: number;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
}

/**
 * The saved placement, with an unreachable position dropped.
 *
 * Dropping x and y rather than clamping them: clamping produces a window jammed into a
 * corner at coordinates the user never chose, which looks like a bug. Letting Electron
 * centre it on the primary display is always reachable and always looks deliberate.
 *
 * An empty display list — which the OS does report briefly during a dock switch — falls back
 * the same way. "No displays" cannot possibly contain the saved position, and answering
 * "sure, keep it" in that window would put the window nowhere.
 */
export function chooseWindowPlacement(
  saved: SavedPlacement,
  displays: readonly DisplayLike[]
): WindowPlacement {
  const size = { width: saved.width, height: saved.height };
  if (saved.x === undefined || saved.y === undefined) return size;

  const bounds: Rect = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
  return isVisibleOnSomeDisplay(bounds, displays) ? { ...size, x: saved.x, y: saved.y } : size;
}
