// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The window's chrome: the three-pane shell, and the tool views that take it over.
 *
 * A barrel for the same reason `chrome/index.ts` and `generator/index.ts` are: the tool view
 * store is reached from the vault screen, from the root (to clear it on lock), and — once
 * the menu bridge lands — from whatever listens for `tools.health` off the native menu. One
 * import site is what stops a second `activeTool` appearing somewhere else.
 */

export { AppShell, type AppShellProps } from './AppShell.js';
export { ToolNav } from './ToolNav.js';
export { ToolView, type ToolViewProps } from './ToolView.js';
export {
  useToolView,
  watchLockForToolViews,
  watchSelectionForToolViews,
} from './tool-view-store.js';
export {
  TOOL_VIEWS,
  TOOL_VIEW_BY_ID,
  TOOL_VIEW_IDS,
  toolViewForMenuCommand,
  type ToolViewDefinition,
  type ToolViewId,
} from './tool-views.js';
