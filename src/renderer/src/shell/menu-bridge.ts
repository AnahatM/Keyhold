// SPDX-License-Identifier: GPL-3.0-or-later
import type { MenuCommandId } from '@shared/model/menu-commands.js';
import { usePaletteStore } from '../commands/palette-store.js';
import { toolViewForMenuCommand } from './tool-views.js';
import { useToolView } from './tool-view-store.js';

/**
 * Native menu and tray commands, routed into the renderer's own stores.
 *
 * ## Why this is a subscription and not a component
 *
 * A menu click can arrive at any moment, including while a screen is being replaced. A
 * listener that unmounts with a screen is a menu item that works on some screens for
 * reasons nobody can see — the same argument `CommandsProvider` makes about its `keydown`
 * listener, and the reason this is started once from `App` rather than mounted per view.
 *
 * ## Why it routes through the registries rather than switching on the id
 *
 * `toolViewForMenuCommand` reads `TOOL_VIEWS`, which is the same table the sidebar rows and
 * the palette entries are built from. A `switch (command)` here would be a fourth place
 * that knows `tools.health` opens the health dashboard, and the fourth copy is the one that
 * gets forgotten when a fifth tool lands.
 *
 * ## What it deliberately does not handle
 *
 * Anything that belongs to a screen's own state — focusing the search box, collapsing the
 * sidebar — is owned by the view that renders it and reaches the command system as an
 * optional handler on `CommandsProvider`. Routing those from here would mean this module
 * reaching across the app into a component's state, which is how a global listener turns
 * into a place every feature has to register itself.
 *
 * An unhandled command is logged, not swallowed. The main process only forwards commands it
 * has already decided are enabled, so one arriving with nowhere to go means the two sides
 * disagree about what this build can do — which is worth saying out loud rather than
 * discovering as a menu item that does nothing.
 */
export function startMenuBridge(): () => void {
  return window.keyhold.app.onMenuCommand((command: MenuCommandId) => {
    const view = toolViewForMenuCommand(command);
    if (view !== null) {
      // `open`, not `toggle`. A menu item is a request for a destination — someone who picks
      // "Vault health" from a menu while already looking at it meant to go there, and having
      // it close instead reads as the click having missed.
      useToolView.getState().open(view);
      return;
    }

    // Not exhaustive, deliberately, and the same judgement `runMenuCommand` makes in the
    // main process. The catalogue has twenty-six commands; four are tool views handled
    // above, three are performed in main, and most of the rest name surfaces this build does
    // not have yet. Listing twenty empty cases would say nothing `AVAILABLE_MENU_COMMANDS`
    // does not already say and would have to be edited twice every time a surface lands.
    // The `default` below is the honest handler for the rest.
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- see above
    switch (command) {
      case 'palette.open':
        usePaletteStore.getState().openPalette();
        return;
      case 'help.shortcuts':
        usePaletteStore.getState().openHelp();
        return;
      default:
        console.warn('[menu] the renderer has no handler for:', command);
    }
  });
}
