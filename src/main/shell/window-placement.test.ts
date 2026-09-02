// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  MIN_VISIBLE_PX,
  chooseWindowPlacement,
  isVisibleOnSomeDisplay,
  type DisplayLike,
} from './window-placement.js';

/**
 * The invisible-window failure.
 *
 * Someone works on a laptop with an external monitor, closes Keyhold with the window on it,
 * unplugs the monitor, and reopens. The process runs, the taskbar shows it, and there is no
 * window anywhere. It is indistinguishable from a crash and it is entirely preventable.
 *
 * The display list is a parameter here rather than `screen.getAllDisplays()`, which is what
 * lets these arrangements be tested on a machine that has one monitor.
 */

const LAPTOP: DisplayLike = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const SECOND_SCREEN_RIGHT: DisplayLike = {
  workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
};
/** A display placed to the left of the primary — negative coordinates are legal and common. */
const SECOND_SCREEN_LEFT: DisplayLike = {
  workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
};

describe('deciding whether a saved position is still real', () => {
  it('keeps a position on a display that still exists', () => {
    const placement = chooseWindowPlacement({ x: 100, y: 100, width: 1180, height: 760 }, [LAPTOP]);

    expect(placement).toEqual({ x: 100, y: 100, width: 1180, height: 760 });
  });

  it('drops a position on a monitor that has been unplugged', () => {
    // x: 2400 was on the second screen. With only the laptop present it is nowhere.
    const placement = chooseWindowPlacement({ x: 2400, y: 300, width: 1180, height: 760 }, [
      LAPTOP,
    ]);

    // No x/y means Electron centres it, which is always reachable. Clamping to an edge
    // instead would put the window at coordinates the user never chose.
    expect(placement).toEqual({ width: 1180, height: 760 });
  });

  it('keeps that same position while the monitor is still plugged in', () => {
    const placement = chooseWindowPlacement({ x: 2400, y: 300, width: 1180, height: 760 }, [
      LAPTOP,
      SECOND_SCREEN_RIGHT,
    ]);

    expect(placement).toMatchObject({ x: 2400, y: 300 });
  });

  it('handles a display to the left of the origin', () => {
    const placement = chooseWindowPlacement({ x: -1800, y: 100, width: 1180, height: 760 }, [
      LAPTOP,
      SECOND_SCREEN_LEFT,
    ]);

    expect(placement).toMatchObject({ x: -1800, y: 100 });
  });

  it('falls back when there are no displays at all', () => {
    // Briefly reported by the OS during a dock switch. "No displays" cannot contain the
    // saved position, and answering "sure, keep it" in that window puts the window nowhere.
    const placement = chooseWindowPlacement({ x: 100, y: 100, width: 1180, height: 760 }, []);

    expect(placement).toEqual({ width: 1180, height: 760 });
  });

  it('returns the size unchanged when nothing was saved', () => {
    expect(chooseWindowPlacement({ width: 1180, height: 760 }, [LAPTOP])).toEqual({
      width: 1180,
      height: 760,
    });
  });

  it('drops a position with only one axis saved', () => {
    // A half-written state file. Half a position is not a position.
    expect(chooseWindowPlacement({ x: 100, width: 1180, height: 760 }, [LAPTOP])).toEqual({
      width: 1180,
      height: 760,
    });
  });
});

describe('the grabbable-overlap threshold', () => {
  it('accepts a window peeking slightly off the edge', () => {
    // Deliberate, common, and not a failure. What matters is that enough is grabbable.
    const bounds = { x: 1920 - MIN_VISIBLE_PX - 1, y: 200, width: 1180, height: 760 };

    expect(isVisibleOnSomeDisplay(bounds, [LAPTOP])).toBe(true);
  });

  it('rejects a window with less than the threshold on screen', () => {
    const bounds = { x: 1920 - MIN_VISIBLE_PX + 1, y: 200, width: 1180, height: 760 };

    expect(isVisibleOnSomeDisplay(bounds, [LAPTOP])).toBe(false);
  });

  it('requires the overlap on both axes, not either', () => {
    // Horizontally fine, vertically below the display entirely. A window whose title bar is
    // off the bottom of the screen cannot be dragged back.
    const bounds = { x: 100, y: 1039, width: 1180, height: 760 };

    expect(isVisibleOnSomeDisplay(bounds, [LAPTOP])).toBe(false);
  });

  it('is satisfied by any one display, not all of them', () => {
    const onSecondOnly = { x: 2400, y: 300, width: 1180, height: 760 };

    expect(isVisibleOnSomeDisplay(onSecondOnly, [LAPTOP, SECOND_SCREEN_RIGHT])).toBe(true);
  });
});
