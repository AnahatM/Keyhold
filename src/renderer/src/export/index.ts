// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The export dialog — roadmap Phase 11.
 *
 * One entry point for the app (`ExportDialog`) and one port to the outside world
 * (`ExportGateway`). Everything else here is internal to the flow, and is exported only so
 * that the parts worth testing can be tested without a renderer.
 *
 * The fake gateway is deliberately **not** re-exported: nothing in the app should be able to
 * reach a test double by importing the feature's barrel. Tests import
 * `./fake-export-gateway.js` by path, which makes every use of it visible in a search.
 */

export { ExportDialog, type ExportDialogProps } from './ExportDialog.js';
export {
  exportGatewayFrom,
  type ExportBridge,
  type ExportGateway,
  type StrengthEstimator,
} from './export-gateway.js';
export {
  buildExportPlan,
  canAdvance,
  confirmationSatisfied,
  emptyDraft,
  EXPORT_STEPS,
  EXPORT_STEP_HEADINGS,
  EXPORT_STEP_LABELS,
  nextStep,
  previousStep,
  resetDraft,
  scopeIsUsable,
  stepIndex,
  type ExportDraft,
  type ExportStep,
} from './export-steps.js';
export {
  affectedFields,
  formatBytes,
  groupLossesByKind,
  LOSS_KIND_LABELS,
  LOSS_KIND_MEANINGS,
  LOSS_KIND_ORDER,
  LOSS_KIND_ICONS,
  LOSS_KIND_TONES,
  recordSentence,
  safetyBadge,
  summariseLosses,
  trashSentence,
  unknownSentence,
  type LossGroup,
  type SafetyBadge,
} from './export-presentation.js';
export {
  useExportDialog,
  type ExportDialogController,
  type ExportScopeMode,
  type ExportStatus,
} from './use-export-dialog.js';
