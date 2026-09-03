// SPDX-License-Identifier: GPL-3.0-or-later
import { isMenuCommandId, MENU_COMMAND_IDS } from '@shared/model/menu-commands.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePaletteStore } from '../commands/palette-store.js';
import { startMenuBridge } from './menu-bridge.js';
import { TOOL_VIEWS } from './tool-views.js';
import { useToolView } from './tool-view-store.js';

/**
 * Guard: a native menu item reaches something.
 *
 * The menu was fully built — twenty-six commands, a tray, enablement rules, a parity test
 * against the renderer's shortcut table — and every item that was not one of the three the
 * main process performs itself did nothing at all when clicked. Not an error, not a
 * message: nothing. That is the failure mode a menu is worst at showing, because a menu
 * item that does nothing looks exactly like one whose effect you did not notice.
 *
 * These tests drive the bridge the way the preload does, so they cover the routing rather
 * than the transport.
 */

let listener: ((command: string) => void) | null = null;
let unsubscribed = false;

beforeEach(() => {
  listener = null;
  unsubscribed = false;
  vi.stubGlobal('window', {
    keyhold: {
      app: {
        onMenuCommand: (fn: (command: string) => void) => {
          listener = fn;
          return () => {
            unsubscribed = true;
          };
        },
      },
    },
  });
  useToolView.getState().close();
  usePaletteStore.getState().closePalette();
  usePaletteStore.getState().closeHelp();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the menu bridge', () => {
  it('opens every tool view its command names', () => {
    // Driven from `TOOL_VIEWS` rather than four literals, so a fifth tool is covered here
    // the moment it is added — the same reason the palette entries are generated.
    const stop = startMenuBridge();
    for (const view of TOOL_VIEWS) {
      useToolView.getState().close();
      listener?.(view.menuCommandId);
      expect(useToolView.getState().active, view.menuCommandId).toBe(view.id);
    }
    stop();
  });

  it('opens rather than toggles, so picking the open one is not a close', () => {
    // Someone choosing "Vault health" from a menu while already looking at it meant to go
    // there. Having it close instead reads as the click having missed.
    const stop = startMenuBridge();
    listener?.('tools.health');
    listener?.('tools.health');
    expect(useToolView.getState().active).toBe('health');
    stop();
  });

  it('opens the palette and the shortcut sheet', () => {
    const stop = startMenuBridge();
    listener?.('palette.open');
    expect(usePaletteStore.getState().paletteOpen).toBe(true);

    listener?.('help.shortcuts');
    expect(usePaletteStore.getState().helpOpen).toBe(true);
    stop();
  });

  it('warns rather than silently dropping a command it cannot place', () => {
    // The main process only forwards commands it has already decided are enabled, so one
    // arriving with nowhere to go means the two sides disagree about what this build can do.
    // Worth saying out loud rather than discovering as a menu item that does nothing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stop = startMenuBridge();

    listener?.('vault.export');
    expect(warn).toHaveBeenCalledOnce();
    stop();
    warn.mockRestore();
  });

  it('unsubscribes when stopped', () => {
    startMenuBridge()();
    expect(unsubscribed).toBe(true);
  });
});

describe('the shared command vocabulary', () => {
  it('accepts every real name and nothing else', () => {
    // The preload calls this before forwarding, so a gap here is a payload the renderer
    // receives untyped. `'__proto__'` is in the list because `includes` on an array is
    // immune to it and a `Record` lookup would not have been — the kind of difference worth
    // pinning rather than rediscovering.
    for (const id of MENU_COMMAND_IDS) expect(isMenuCommandId(id)).toBe(true);
    for (const bad of ['', 'vault', 'VAULT.LOCK', '__proto__', 'toString', null, 7, {}]) {
      expect(isMenuCommandId(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('names every tool view s menu command', () => {
    // A tool view whose `menuCommandId` is not in the catalogue is a menu item that can
    // never be sent, and nothing else would notice: the sidebar and palette do not read it.
    for (const view of TOOL_VIEWS) {
      expect(MENU_COMMAND_IDS as readonly string[], view.id).toContain(view.menuCommandId);
    }
  });
});
