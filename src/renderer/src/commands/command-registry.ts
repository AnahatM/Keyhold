// SPDX-License-Identifier: GPL-3.0-or-later
import { TOOL_VIEWS, type ToolViewId } from '../shell/tool-views.js';

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
  | 'help.shortcuts'
  | 'vault.import'
  | 'vault.export'
  | 'vault.merge'
  /**
   * One per tool view, generated rather than listed.
   *
   * `TOOL_VIEWS` already knows every tool's name and what it is for, and the sidebar reads
   * that same table. Writing four more entries here by hand would be rule 8's second list,
   * and the failure mode is specific: someone adds a fifth tool, the sidebar grows a row,
   * and the palette silently does not — which nobody notices, because the palette is the
   * surface people use when they have *forgotten* where something is.
   */
  | `tools.${ToolViewId}`;

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
/**
 * Which section each tool view belongs in.
 *
 * A `Record<ToolViewId, CommandSection>` rather than a rule like "help goes in Help": adding
 * a tool view is then a **compile error here** until someone says where it belongs, rather
 * than a command that quietly lands in whichever section a default picked. That is the
 * whole reason this map exists instead of a ternary.
 *
 * Sections live in this file because they are a property of the palette, not of the tool —
 * the sidebar has no sections and the menu has different ones.
 */
const TOOL_SECTION: Readonly<Record<ToolViewId, CommandSection>> = {
  generator: 'Vault',
  health: 'Vault',
  settings: 'Navigate',
  help: 'Help',
  about: 'Help',
};

/**
 * Extra search terms per tool, for the words people actually type.
 *
 * Separate from the tool's `summary`, which is written to be *read* by someone hovering a
 * sidebar row. These are written to be *matched*: nobody types "eight offline checks over
 * every record", they type "weak" or "reused" or "audit". Optional per tool, because a tool
 * whose title is already the word people reach for does not need any.
 */
const TOOL_KEYWORDS: Readonly<Partial<Record<ToolViewId, readonly string[]>>> = {
  generator: ['random', 'passphrase', 'pin', 'new password', 'make'],
  health: ['weak', 'reused', 'duplicate', 'old', 'audit', 'score', 'checkup'],
  settings: ['preferences', 'options', 'configure', 'auto-lock', 'clipboard', 'theme'],
  help: ['docs', 'documentation', 'manual', 'guide', 'how to', 'about'],
};

/**
 * A palette entry per tool view, built from the table the sidebar reads.
 *
 * `requiresSelection: false` on every one, and that is not a formality: a tool view answers
 * a question that is not about a record, which is the entire reason they are a separate
 * region of the shell rather than a fourth pane. Opening one while a record is selected is
 * normal — the selection is simply set aside.
 */
const TOOL_COMMANDS: readonly CommandDefinition[] = TOOL_VIEWS.map((view) => ({
  id: `tools.${view.id}` as const,
  title: view.title,
  section: TOOL_SECTION[view.id],
  keywords: TOOL_KEYWORDS[view.id] ?? [],
  requiresSelection: false,
  destructive: false,
}));

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
  {
    id: 'vault.import',
    title: 'Import from another password manager',
    section: 'Vault',
    keywords: ['bitwarden', 'lastpass', '1password', 'keepass', 'chrome', 'csv', 'migrate'],
    requiresSelection: false,
    destructive: false,
  },
  {
    id: 'vault.export',
    title: 'Export this vault',
    section: 'Vault',
    keywords: ['backup', 'copy', 'csv', 'json', 'parcel', 'transfer', 'leave', 'migrate'],
    requiresSelection: false,
    // Not `destructive`, deliberately, and it is worth saying why: `destructive` marks a
    // command that damages the vault, and an export changes nothing in it. The danger of a
    // plaintext export is to the *copy*, and that is guarded where it belongs — by the
    // type-to-confirm step in the dialog, checked again in the main process.
    destructive: false,
  },
  {
    id: 'vault.merge',
    title: 'Merge another copy of this vault',
    section: 'Vault',
    keywords: ['sync', 'combine', 'reconcile', 'conflict', 'copy', 'other', 'device', 'dropbox'],
    requiresSelection: false,
    // Not `destructive`: a merge takes a mandatory backup of this vault before it changes
    // anything, and every conflict is settled by the user rather than by a rule. The
    // irreversible-looking part is guarded by the backup, not by a confirmation.
    destructive: false,
  },
  ...TOOL_COMMANDS,
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
