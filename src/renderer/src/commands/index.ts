// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Shortcuts and the command palette — roadmap Phase 15.
 *
 * One thing has to be mounted: `<CommandsProvider />`. Everything else in here is either
 * read by it or is a pure function a test can reach.
 *
 * A barrel for the same reason the chrome has one: this is consumed from the app shell and
 * from the views that own the two actions the provider cannot derive, and one import site
 * is the difference between the registry being used and someone adding a `keydown`
 * listener of their own because they could not remember where the table lived.
 */

export { CommandsProvider, type CommandsProviderProps } from './CommandsProvider.js';
export { CommandPalette, type CommandPaletteProps } from './CommandPalette.js';
export { ShortcutsHelp, type ShortcutsHelpProps } from './ShortcutsHelp.js';

export {
  SHORTCUTS,
  SHORTCUT_BY_ID,
  SHORTCUT_SCOPES,
  SCOPE_LABELS,
  SCOPE_DESCRIPTIONS,
  findShortcutConflicts,
  scopesOverlap,
  shortcutById,
  shortcutsInScope,
  type ShortcutConflict,
  type ShortcutDefinition,
  type ShortcutId,
  type ShortcutScope,
} from './shortcut-registry.js';

export {
  COMMANDS,
  COMMAND_BY_ID,
  COMMAND_SECTIONS,
  resolveCommands,
  type CommandDefinition,
  type CommandHandler,
  type CommandHandlers,
  type CommandId,
  type CommandSection,
  type ResolvedCommand,
} from './command-registry.js';

export {
  combo,
  combosEqual,
  comboId,
  describeCombo,
  formatCombo,
  matchesEvent,
  normaliseKey,
  type KeyCombo,
  type KeyEventLike,
} from './key-combo.js';

export { activeScopes, canFire, type ShortcutEnvironment } from './shortcut-gate.js';
export { isTextEntryElement, isTypingInto } from './text-entry.js';
export { useShortcuts, type ShortcutHandler, type ShortcutHandlers } from './use-shortcuts.js';

export {
  anyOverlayOpen,
  loadPlatform,
  openCommandPalette,
  usePaletteStore,
} from './palette-store.js';
export {
  MAX_RECENTS,
  pushRecent,
  useRecentCommands,
  watchLockForRecents,
} from './recent-commands.js';

export {
  MAX_CREDENTIAL_RESULTS,
  commandKey,
  credentialKey,
  itemDetail,
  itemTitle,
  matchReason,
  searchPalette,
  type PaletteItem,
  type PaletteSearchInput,
  type PaletteSearchResult,
} from './palette-search.js';
export { matchCommand, searchCommands, type CommandMatch } from './command-match.js';
export {
  RECENT_GROUP_LABEL,
  flattenGroups,
  groupPaletteItems,
  type PaletteGroup,
} from './palette-groups.js';
export {
  isNavigationKey,
  nextIndex,
  resolveActiveIndex,
  type NavigationKey,
} from './list-navigation.js';
