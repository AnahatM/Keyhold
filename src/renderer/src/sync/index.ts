// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The merge conflict resolver — the screen where a user settles a merge.
 *
 * One entry point for the app (`MergeResolver`) and one port to the outside world
 * (`SyncGateway`, adapted from `window.keyhold.sync` by `createIpcSyncGateway`). Everything else
 * is exported so the parts worth testing can be tested without rendering, and because the copy
 * modules are the kind of thing a settings screen or a status bar will eventually want to quote.
 *
 * `fake-sync-gateway.ts` and `test-fixtures.ts` are deliberately **not** re-exported: nothing in
 * the app should be able to reach a test double by importing the feature's barrel. Tests import
 * them by path, which makes every use of them visible in a search.
 */

export { MergeFlow, type MergeFlowProps } from './MergeFlow.js';
export { MergeResolver, type MergeResolverProps } from './MergeResolver.js';

export { createIpcSyncGateway } from './ipc-sync-gateway.js';
export {
  SyncGatewayError,
  SYNC_ERROR_ADVICE,
  SYNC_ERROR_CODES,
  syncErrorMessage,
  type SyncErrorCode,
  type SyncGateway,
} from './sync-gateway.js';

export {
  emptyTargetNames,
  fallbackName,
  nameTarget,
  targetNamesFrom,
  TARGET_KIND_NOUNS,
  type MergeTargetKind,
  type MergeTargetNames,
  type TargetName,
  type TargetNameInput,
} from './merge-targets.js';

export {
  conflictQuestion,
  describeSide,
  fieldLabel,
  hidesValue,
  targetKindOf,
  CONFLICT_KIND_MEANINGS,
  CONFLICT_KIND_SYMBOLS,
  type SideEntry,
  type SideSummary,
} from './conflict-language.js';

export {
  countsSentence,
  modeNotice,
  remainingHeadline,
  showsAncestor,
  MERGE_MODE_EXPLANATIONS,
  MERGE_MODE_HEADLINES,
  MERGE_MODE_LABELS,
  SIDE_HEADINGS,
  type MergeModeNotice,
} from './merge-mode.js';

export {
  carryOver,
  choose,
  effectiveChoice,
  isChoosable,
  seedSelections,
  statusOf,
  summarise,
  toResolutions,
  NO_SELECTIONS,
  type ConflictStatus,
  type ResolutionSummary,
  type Selections,
} from './resolution-state.js';

export {
  filterCounts,
  filterGroups,
  groupConflicts,
  initiallyExpanded,
  pageOfGroups,
  AUTO_EXPAND_LIMIT,
  CONFLICT_FILTERS,
  CONFLICT_FILTER_LABELS,
  GROUP_PAGE_SIZE,
  type ConflictFilter,
  type ConflictGroup,
  type GroupPage,
} from './conflict-groups.js';

export {
  acrossTargetRefusal,
  applySweep,
  describeSweep,
  planSweep,
  refusalSentence,
  SWEEP_REFUSALS,
  type SweepPlan,
  type SweepRefusal,
  type SweepRefusalReason,
  type SweepScope,
} from './bulk-resolution.js';

export {
  groupNotes,
  noteCountNoun,
  notesHeadline,
  totalNotes,
  type MergeNoteGroup,
  type MergeNoteSeverity,
} from './merge-notes.js';

export {
  useMergeResolver,
  type CheckOutcome,
  type MergeResolverController,
  type MergeResolverOptions,
  type PrimaryAction,
  type ResolverPhase,
} from './use-merge-resolver.js';
