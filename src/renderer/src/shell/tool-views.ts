// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The tool views — the vault window's second navigation axis, as data.
 *
 * The three-pane shell answers one question: *which record?* Three finished screens answer
 * questions that are not about a record at all — how healthy is this vault, make me a
 * password, how does this thing work — and none of them fits in a pane sized for a
 * credential. Squeezing the health dashboard into the detail column, or the two-column help
 * viewer into a 320px list, is how a finished screen ends up looking unfinished.
 *
 * So a tool takes over the main region instead: the sidebar stays (the way back is never
 * off-screen), and the list and detail step aside for as long as the tool is open. That is
 * the same shape the app already uses when a narrow window makes the detail pane take over
 * from the list — it is one more mode of an existing idea, not a new one.
 *
 * ## Why this is a table and not a switch
 *
 * Four things need to agree about what a tool view is: the sidebar rows that open one, the
 * `<h1>` at the top of it, the component the vault screen mounts, and the native menu
 * commands in `src/main/shell/menu-commands.ts` that will trigger it. Hard rule 8 — one
 * route table. A definition here carries no component and no behaviour, exactly like
 * `command-registry.ts`: it is importable from a test and diffable when someone adds a
 * tool, and `VaultScreen.tsx` supplies the mounting in one exhaustive switch that TypeScript
 * fails to compile if a new id is left out.
 *
 * ## `menuCommandId`
 *
 * The main process cannot import from `src/renderer` — the two halves are separate
 * TypeScript programs, deliberately. `menu-commands.ts` already names `tools.generator`,
 * `tools.health`, `app.settings` and `help.docs`; naming them back here means the eventual
 * bridge is a lookup (`toolViewForMenuCommand`) rather than a third copy of the mapping
 * written inside an IPC listener.
 */

/**
 * `settings` is deliberately absent, and it is the only one that is.
 *
 * `SettingsScreen` is written and mounted-ready, but `settings/settings-gateway.ts` still
 * refuses every read with "Phase 14 has not registered kh:settings:read" — a renderer-side
 * stub written before that channel existed. It exists now (`register.ts` handles
 * `CHANNELS.settingsRead`, and the preload exposes `window.keyhold.settings.read`), so the
 * gateway is the only thing left, and it is not in this pass's remit. Until it is replaced,
 * `app.settings` has nowhere to go that is not an error page, and a permanent sidebar row
 * that only ever fails is worse than one that is not there yet. See the handover note for
 * the four lines that add it back.
 */
export const TOOL_VIEW_IDS = ['generator', 'health', 'help'] as const;

export type ToolViewId = (typeof TOOL_VIEW_IDS)[number];

export interface ToolViewDefinition {
  readonly id: ToolViewId;
  /**
   * The page's `<h1>` **and** the label of the sidebar row that opens it.
   *
   * One string in one place: a nav row reading "Generate" that lands on a page titled
   * "Password tools" is the small kind of drift nothing ever tests.
   */
  readonly title: string;
  /** Read out by the sidebar row's accessible description — says what the tool is for. */
  readonly summary: string;
  /**
   * The command in `src/main/shell/menu-commands.ts` that opens this view.
   *
   * A plain string rather than an imported union, for the reason in the file header.
   * `tool-views.test.ts` checks these are unique; `shortcut-parity.ts` is the model for
   * checking them against the main-process table once the menu bridge exists.
   */
  readonly menuCommandId: string;
  /**
   * True when the mounted component manages its own height and scrolling.
   *
   * The help viewer is `height: 100%` with a scrolling article column inside it — putting
   * that in a scrolling frame gives two nested scrollbars and an article that never reaches
   * its own bottom. The other three are ordinary flowing documents and want the frame to
   * scroll them.
   */
  readonly fills: boolean;
}

/** The table. Order here is the order the sidebar lists them. */
export const TOOL_VIEWS: readonly ToolViewDefinition[] = [
  {
    id: 'generator',
    title: 'Generate a password',
    summary: 'Make a password or passphrase without opening a record.',
    menuCommandId: 'tools.generator',
    fills: false,
  },
  {
    id: 'health',
    title: 'Vault health',
    summary: 'Eight offline checks over every record in this vault.',
    menuCommandId: 'tools.health',
    fills: false,
  },
  {
    id: 'help',
    title: 'Help',
    summary: 'The whole manual, shipped inside the app. Nothing here needs a connection.',
    menuCommandId: 'help.docs',
    fills: true,
  },
];

export const TOOL_VIEW_BY_ID: ReadonlyMap<ToolViewId, ToolViewDefinition> = new Map(
  TOOL_VIEWS.map((view) => [view.id, view])
);

/**
 * The menu command a native menu item carries, turned into a view.
 *
 * Returns `null` for every other command rather than throwing: the menu has two dozen
 * entries and only four of them are tool views, so "not one of mine" is the normal answer,
 * not an error.
 */
export function toolViewForMenuCommand(menuCommandId: string): ToolViewId | null {
  return TOOL_VIEWS.find((view) => view.menuCommandId === menuCommandId)?.id ?? null;
}
