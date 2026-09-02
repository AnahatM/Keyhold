// SPDX-License-Identifier: GPL-3.0-or-later

import type { ContentArticle } from '../content-types.js';
import { SHORTCUT_COUNT, SHORTCUT_SCOPE_ROWS } from '../shortcuts-source.js';

/**
 * The shortcuts page — everything on it read from the shortcut registry, and not one key
 * combination typed out.
 *
 * `shortcuts-source.ts` carries the full reasoning. The short version: the shortcuts sheet
 * already renders the registry and filters it to the bindings that are actually mounted,
 * which a static article cannot do. A table here would be the complete list rather than the
 * live one, printed where a lost user would trust it most.
 */
export const keyboardShortcutsArticle: ContentArticle = {
  id: 'keyboard-shortcuts',
  title: 'Keyboard shortcuts',
  summary: 'Where the shortcuts live, when each one is allowed to fire, and how to see the list.',
  keywords: ['shortcut', 'shortcuts', 'keys', 'hotkey', 'keybinding', 'accelerator', 'keyboard'],
  related: ['getting-started', 'troubleshooting'],
  body: [
    {
      kind: 'paragraph',
      text: 'Keyhold can be driven from the keyboard. Every control takes focus, the focus outline is always visible, and no part of the interface traps you somewhere you cannot tab out of.',
    },

    { kind: 'heading', text: 'Seeing the list' },
    {
      kind: 'paragraph',
      text: `There is exactly one shortcut table in Keyhold — currently ${SHORTCUT_COUNT} bindings — and two places show it to you. The shortcuts sheet is generated from that table and lists only the shortcuts whose feature is actually available right now, so it never advertises a key that would do nothing. The menu bar at the top of the window prints its own accelerators beside each command, and is also how a screen reader reaches those commands.`,
    },
    {
      kind: 'paragraph',
      text: 'This page deliberately does not repeat either of them. A copied list is one that quietly stops matching the app, and it would have to guess whether to print Ctrl or Command before your platform is known.',
    },

    { kind: 'heading', text: 'When a shortcut is allowed to fire' },
    {
      kind: 'paragraph',
      text: 'Every binding belongs to a scope, and the scope decides both where it works and how the sheet groups it.',
    },
    { kind: 'facts', rows: SHORTCUT_SCOPE_ROWS },
    {
      kind: 'note',
      tone: 'info',
      label: 'Typing always wins',
      text: 'A shortcut does not fire while a text field has focus unless it is a modifier combination a text field would never consume. That rule exists for one specific case: a password containing the letter a shortcut is bound to must never be able to trigger it.',
    },
    {
      kind: 'note',
      tone: 'info',
      label: 'A locked vault stays locked',
      text: 'Almost nothing is allowed to fire while the vault is locked, and the few that are say so on the sheet. A shortcut that reached vault contents through a closed door would be a bug with a keyboard in front of it.',
    },
    {
      kind: 'not-built',
      feature: 'shortcuts',
      text: 'The registry, the key handler, the command palette and the shortcuts sheet are all written and tested, but nothing in the app window mounts them yet — so no shortcut fires today except the accelerators the native menu bar owns. This callout goes away when the shortcut provider is mounted in the app shell.',
    },
  ],
};
