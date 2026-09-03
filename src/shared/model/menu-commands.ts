// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The names of every action the native shell can invoke.
 *
 * The *catalogue* — labels, accelerators, the two security flags — stays in
 * `src/main/shell/menu-commands.ts`, because a menu label is main-process business and the
 * renderer has no use for one. Only the **vocabulary** lives here, and it lives here for a
 * specific reason: a menu click has to reach the renderer, and the preload has to be able
 * to refuse a payload that is not one of these before forwarding it.
 *
 * Without a shared list the preload would have had two bad options. It could forward
 * whatever string arrived, which turns a main → renderer event into an untyped channel the
 * renderer has to defend itself against — the exact shape decision D13 spends its effort
 * avoiding in the other direction. Or it could keep its own copy of the twenty-six names,
 * which is rule 8's second list in the one file where a mistake is least visible.
 *
 * So: one list, in `shared/`, imported by both. `src/main/shell/menu-commands.ts`
 * re-exports it under the name it already used, so nothing on the main side changed.
 *
 * ## Order is the menu's order, and it is load-bearing
 *
 * `menu-model.ts` reads this to build sections. Reordering it reorders the menu, which is
 * why entries are appended rather than inserted alphabetically.
 */
export const MENU_COMMAND_IDS = [
  'vault.new',
  'vault.open',
  'vault.save',
  'vault.lock',
  'vault.close',
  'vault.import',
  'vault.export',
  'vault.merge',
  'credential.new',
  'search.focus',
  'palette.open',
  'view.sidebar',
  'view.theme.system',
  'view.theme.light',
  'view.theme.dark',
  'vault.trash',
  'tools.generator',
  'tools.health',
  'app.settings',
  'help.docs',
  'help.shortcuts',
  'help.security',
  'help.reportIssue',
  'help.about',
  'window.show',
  'window.hide',
  'app.quit',
] as const;

export type MenuCommandId = (typeof MENU_COMMAND_IDS)[number];

/**
 * Whether a string is a command name.
 *
 * Used by the preload to refuse anything else before it reaches the renderer. A type guard
 * rather than a cast, because the payload arrives over IPC where the annotation is gone and
 * "the main process would never send that" is an assumption rather than a check.
 */
export function isMenuCommandId(value: unknown): value is MenuCommandId {
  return typeof value === 'string' && (MENU_COMMAND_IDS as readonly string[]).includes(value);
}
