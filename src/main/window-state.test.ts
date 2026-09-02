// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The off-screen-restore guard.
 *
 * This is the only part of window-state worth testing, and it is worth testing because the
 * failure is invisible and looks exactly like a crash: the user closes Keyhold with the
 * window on an external monitor, unplugs the monitor, reopens — and there is no window.
 * The process is running, the taskbar shows it, and nothing can be clicked.
 *
 * `screen` is mocked to simulate display arrangements that cannot be produced on the test
 * machine.
 */

const displays = vi.hoisted(() => ({
  current: [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/keyhold-test' },
  screen: { getAllDisplays: () => displays.current },
}));

const loadModule = async () => import('./window-state.js');

beforeEach(() => {
  displays.current = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  vi.resetModules();
});

describe('restoring a window position', () => {
  it('keeps a position that is on the current display', async () => {
    const { windowOptionsFromState } = await loadModule();
    const options = windowOptionsFromState({
      x: 100,
      y: 100,
      width: 1180,
      height: 760,
      maximised: false,
    });

    expect(options.x).toBe(100);
    expect(options.y).toBe(100);
  });

  it('discards a position on a monitor that is no longer connected', async () => {
    // The whole reason this module exists. A window at x: 2400 was on a second monitor;
    // with only the primary display present, restoring there means an invisible window.
    const { windowOptionsFromState } = await loadModule();
    const options = windowOptionsFromState({
      x: 2400,
      y: 300,
      width: 1180,
      height: 760,
      maximised: false,
    });

    // No x/y means Electron centres it — always reachable.
    expect(options.x).toBeUndefined();
    expect(options.y).toBeUndefined();
    expect(options.width).toBe(1180);
  });

  it('restores onto a second monitor when that monitor is still there', async () => {
    displays.current = [
      { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
      { workArea: { x: 1920, y: 0, width: 2560, height: 1400 } },
    ];

    const { windowOptionsFromState } = await loadModule();
    const options = windowOptionsFromState({
      x: 2400,
      y: 300,
      width: 1180,
      height: 760,
      maximised: false,
    });

    expect(options.x).toBe(2400);
  });

  it('handles a monitor positioned to the left, where coordinates go negative', async () => {
    displays.current = [
      { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } },
      { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    ];

    const { windowOptionsFromState } = await loadModule();
    const options = windowOptionsFromState({
      x: -1500,
      y: 200,
      width: 1180,
      height: 760,
      maximised: false,
    });

    expect(options.x).toBe(-1500);
  });

  it('keeps a window that hangs slightly off an edge — often deliberate', async () => {
    const { windowOptionsFromState } = await loadModule();
    const options = windowOptionsFromState({
      x: 1800,
      y: 50,
      width: 1180,
      height: 760,
      maximised: false,
    });

    // 120px is still on screen, which is plenty to grab and drag back.
    expect(options.x).toBe(1800);
  });

  it('discards a window with only a sliver visible — not enough to grab', async () => {
    const { windowOptionsFromState } = await loadModule();
    const options = windowOptionsFromState({
      x: 1900,
      y: 50,
      width: 1180,
      height: 760,
      maximised: false,
    });

    expect(options.x).toBeUndefined();
  });

  it('discards a position above the top of the screen, where the title bar is unreachable', async () => {
    const { windowOptionsFromState } = await loadModule();
    const options = windowOptionsFromState({
      x: 100,
      y: -700,
      width: 1180,
      height: 760,
      maximised: false,
    });

    expect(options.y).toBeUndefined();
  });

  it('passes through a state with no saved position at all', async () => {
    const { windowOptionsFromState } = await loadModule();
    const options = windowOptionsFromState({ width: 900, height: 600, maximised: false });

    expect(options).toEqual({ width: 900, height: 600 });
  });
});

describe('reading a saved state', () => {
  it('falls back to defaults when there is no file', async () => {
    const { readWindowState } = await loadModule();
    const state = readWindowState();

    expect(state.width).toBeGreaterThan(0);
    expect(state.height).toBeGreaterThan(0);
    expect(state.maximised).toBe(false);
  });
});
