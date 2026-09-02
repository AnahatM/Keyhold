// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The organisation sidebar — roadmap Phase 7.
 *
 * One import path, for the same reason `chrome/index.ts` has one: these are consumed from
 * the vault screen and from the list pane, and a barrel is the difference between the module
 * being used and being partially reimplemented by whoever could not remember where
 * `visibleForSelection` lived.
 *
 * The two things a caller outside this directory actually needs:
 *
 *   <OrganisationSidebar />   the sidebar, mounted in VaultScreen
 *   visibleForSelection(...)  the filtered, ranked, ordered list for the list pane
 *
 * Everything else is exported for tests and for the eventual main-process wiring.
 */

export { OrganisationSidebar } from './OrganisationSidebar.js';

export {
  DEFAULT_SELECTION,
  composeQueryText,
  countRecordsByTag,
  isTagSelected,
  resolveSelection,
  toggleTag,
  visibleForSelection,
  type OrganisationContext,
  type ResolvedView,
  type SidebarSelection,
  type ViewSelection,
  type VisibleListOptions,
} from './selection.js';

export {
  DEFAULT_SMART_VIEW_ID,
  RECENT_VIEW_LIMIT,
  SMART_VIEWS,
  SMART_VIEW_BY_ID,
  SMART_VIEW_IDS,
  hasBeenUsed,
  isSmartViewId,
  smartView,
  type SmartView,
  type SmartViewId,
} from './smart-views.js';

export {
  MAX_RENDER_DEPTH,
  ancestorIdsOf,
  buildFolderTree,
  compareFolderSiblings,
  descendantIdsOf,
  expandableIds,
  flattenVisible,
  type FolderAttachment,
  type FolderNode,
  type FolderProblem,
  type FolderProblemKind,
  type FolderTree as FolderTreeModel,
  type TreeRow,
} from './folder-tree-model.js';

export {
  countRecordsByFolder,
  folderDeletionImpact,
  type FolderCounts,
  type FolderDeletionImpact,
} from './folder-counts.js';

export {
  canDropFolder,
  credentialMoveTargets,
  folderMoveTargets,
  nextSiblingOrder,
  type MoveTarget,
} from './move-targets.js';

export {
  HANDLED_TREE_KEYS,
  expandToReveal,
  focusAfterRemoval,
  isHandledTreeKey,
  treeKeyAction,
  type TreeKeyAction,
} from './tree-keyboard.js';

export {
  MAX_PERSISTED_IDS,
  browserExpansionStore,
  expansionStorageKey,
  pruneExpansion,
  readExpansion,
  writeExpansion,
  type ExpansionStore,
} from './expansion-storage.js';

export {
  DEFAULT_TAG_COLOUR,
  TAG_COLOUR_TOKENS,
  isTagColourToken,
  resolveTagColour,
  tagColourLabel,
  tagSwatchColour,
  type TagColourToken,
} from './tag-colours.js';

export {
  CREDENTIAL_DRAG_TYPE,
  FOLDER_DRAG_TYPE,
  dragKindFromTypes,
  dragTypeFor,
  readDragPayload,
  writeDragPayload,
  type DragKind,
  type DragPayload,
} from './drag-payload.js';

export {
  EMPTY_SNAPSHOT,
  FOLDER_DELETION_POLICIES,
  ORGANISATION_UNAVAILABLE,
  OrganisationError,
  type FolderDeletionOutcome,
  type FolderDeletionPolicy,
  type FolderDeletionResult,
  type OrganisationGateway,
  type OrganisationSnapshot,
} from './gateway.js';

export { createIpcOrganisationGateway, isOrganisationBridgeAvailable } from './ipc-gateway.js';
export { useOrganisation, type OrganisationState } from './organisation-store.js';
