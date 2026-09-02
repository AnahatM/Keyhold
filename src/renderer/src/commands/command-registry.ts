// SPDX-License-Identifier: GPL-3.0-or-later

import type { ShortcutId } from './shortcut-registry.js';

/**
 * What the palette can do, as data.
 *
 * A definition carries no behaviour — no `run`, no closure, no store reference. The list is
 * therefore importable from a test, renderable without an app around it, and diffable when
 * someone adds a command. Behaviour is supplied separately, at mount, by whoever actually
 * owns the state a command touches (see `resolveCommands` at the bottom of this file).
 *
 * Commands do not restate their key combination. They name a `shortcutId` and the label is
 * read out of the shortcut table — hard rule 8. A command carrying its own `"Ctrl+L"`
 * string would be a second list, and the copy that drifts is always the one nothing tests.
 *
 * ## What is deliberately absent
 *
 * **Nothing here reveals or copies a secret.** There is no "copy password" command, even
 * though the shortcut table has that binding: a shortcut is aimed at a record the user has
 * already selected and is looking at, whereas the palette is a *search surface* over
 * titles and usernames. Putting a secret-copying action behind a fuzzy text match — where
 * the wrong row can be highlighted at the moment Enter is pressed — is how a password ends
 * up on the clipboard for a record the user never meant. The palette navigates and
 * triggers; it does not read.
 */

export const COMMAND_SECTIONS = ['Vault', 'Navigate', 'Record', 'Help'] as const;

export type CommandSection = (typeof COMMAND_SECTIONS)[number];

export type CommandId =
  | 'vault.lock'
  | 'vault.save'
  | 'credential.new'
  | 'credential.edit'
  | 'credential.duplicate'
  | 'credential.trash'
  | 'nav.allItems'
  | 'nav.trash'
  | 'nav.toggleSidebar'
  | 'search.focus'
  | 'help.shortcuts';

export interface CommandDefinition {
  readonly id: CommandId;
  /** What the palette shows and what a query is matched against first. */
  readonly title: string;
  readonly section: CommandSection;
  /**
   * Words a user might reach for that are not in the title.
   *
   * "Close" for lock, "delete" for trash, "clone" for duplicate. These are the difference
   * between a palette that feels like it read your mind and one that only works if you
   * already know what the command is called.
   */
  readonly keywords: readonly string[];
  /** The binding in the shortcut table, if this command has one. */
  readonly shortcutId?: ShortcutId;
  /** Hidden unless a record is selected — a command that cannot act is noise. */
  readonly requiresSelection: boolean;
  /**
   * Loses data if run by accident.
   *
   * Marked so the palette can label it rather than colour it: WCAG 1.4.1 — never colour
   * alone — and the row is a text row, so a red tint would be the only signal.
   */
  readonly destructive: boolean;
}

/** The table. Order here is the order the palette lists them with an empty query. */
export const COMMANDS: readonly CommandDefinition[] = [
  {
    id: 'credential.new',
    title: 'New credential',
    section: 'Record',
    keywords: ['add', 'create', 'login', 'password', 'entry'],
    shortcutId: 'credential.new',
    requiresSelection: false,
    destructive: false,
  },
  {
    id: 'credential.edit',
    title: 'Edit the selected record',
    section: 'Record',
    keywords: ['change', 'modify', 'update'],
    shortcutId: 'credential.edit',
    requiresSelection: true,
    destructive: false,
  },
  {
    id: 'credential.duplicate',
    title: 'Duplicate the selected record',
    section: 'Record',
    keywords: ['copy record', 'clone'],
    requiresSelection: true,
    destructive: false,
  },
  {
    id: 'credential.trash',
    title: 'Move the selected record to Trash',
    section: 'Record',
    keywords: ['delete', 'remove', 'bin'],
    shortcutId: 'credential.trash',
    requiresSelection: true,
    destructive: true,
  },
  {
    id: 'vault.save',
    title: 'Save the vault',
    section: 'Vault',
    keywords: ['write', 'flush', 'persist'],
    shortcutId: 'vault.save',
    requiresSelection: false,
    destructive: false,
  },
  {
    id: 'vault.lock',
    title: 'Lock the vault',
    section: 'Vault',
    keywords: ['close', 'secure', 'sign out', 'log out'],
    shortcutId: 'vault.lock',
    requiresSelection: false,
    destructive: false,
  },
  {
    id: 'nav.allItems',
    title: 'Go to all items',
    section: 'Navigate',
    keywords: ['list', 'everything', 'home'],
    requiresSelection: false,
    destructive: false,
  },
  {
    id: 'nav.trash',
    title: 'Go to Trash',
    section: 'Navigate',
    keywords: ['deleted', 'bin', 'removed'],
    shortcutId: 'trash.toggle',
    requiresSelection: false,
    destructive: false,
  },
  {
    id: 'nav.toggleSidebar',
    title: 'Show or hide the sidebar',
    section: 'Navigate',
    keywords: ['collapse', 'expand', 'panel'],
    shortcutId: 'sidebar.toggle',
    requiresSelection: false,
    destructive: false,
  },
  {
    id: 'search.focus',
    title: 'Search the vault',
    section: 'Navigate',
    keywords: ['find', 'filter', 'query'],
    shortcutId: 'search.focus',
    requiresSelection: false,
    destructive: false,
  },
  {
    id: 'help.shortcuts',
    title: 'Keyboard shortcuts',
    section: 'Help',
    keywords: ['keys', 'bindings', 'hotkeys', 'accelerators', 'help'],
    shortcutId: 'shortcuts.help',
    requiresSelection: false,
    destructive: false,
  },
];

export const COMMAND_BY_ID: ReadonlyMap<CommandId, CommandDefinition> = new Map(
  COMMANDS.map((command) => [command.id, command])
);

/**
 * What a command does. Supplied by the mounting component, never by this file.
 *
 * **Synchronous, deliberately** — and identical to `ShortcutHandler`, because the palette
 * row and the key binding for one action must be the same function. A handler that returns
 * a promise would be floated by both call sites (neither a `keydown` listener nor a click
 * handler can await), so its rejection would vanish: "Save the vault" would appear to have
 * worked while the write failed. An action with asynchronous work wraps it and owns its own
 * error path — `saveVault` in `CommandsProvider.tsx` is the shape, try/catch to a toast.
 */
export type CommandHandler = () => void;

/**
 * `| undefined` is written out, not implied by `?`.
 *
 * `exactOptionalPropertyTypes` is on, so a `?` property refuses an explicit `undefined` —
 * and every caller here builds its map with `condition ? undefined : handler`, which is far
 * clearer than conditionally spreading keys into an object.
 */
export type CommandHandlers = Readonly<Partial<Record<CommandId, CommandHandler | undefined>>>;

/** A definition that has been given something to do. */
export interface ResolvedCommand {
  readonly definition: CommandDefinition;
  readonly run: CommandHandler;
}

/**
 * Pairs definitions with the handlers available right now.
 *
 * A command with no handler is **omitted rather than disabled**. A greyed-out row that can
 * never be clicked teaches the user nothing and takes up the space a usable result wanted;
 * and during a phased build, "the handler does not exist yet" and "this action is
 * unavailable in this view" are the same fact from the palette's side.
 *
 * `requiresSelection` is applied here too, for the same reason.
 */
export function resolveCommands(
  handlers: CommandHandlers,
  context: { readonly hasSelection: boolean }
): readonly ResolvedCommand[] {
  const resolved: ResolvedCommand[] = [];
  for (const definition of COMMANDS) {
    if (definition.requiresSelection && !context.hasSelection) continue;
    const run = handlers[definition.id];
    if (run === undefined) continue;
    resolved.push({ definition, run });
  }
  return resolved;
}
