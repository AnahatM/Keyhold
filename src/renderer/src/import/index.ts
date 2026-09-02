// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The import wizard — roadmap Phase 10, the renderer half.
 *
 * One import site for whoever mounts this: the component, the gateway interface it is
 * written against, and the adapter that binds that interface to the preload bridge.
 *
 * Mounting it is three lines:
 *
 * ```tsx
 * const gateway = useMemo(() => createIpcImportGateway(window.keyhold.importer), []);
 * <ImportWizard open={importing} gateway={gateway} onClose={() => setImporting(false)} />
 * ```
 *
 * The in-memory fake and the planted fixture are deliberately **not** re-exported, matching
 * `../export/index.ts`: nothing in the app should be able to reach a test double by
 * importing a feature's barrel. Tests import `./fake-gateway.js` and `./test-fixtures.js`
 * by path, which makes every use of them visible in a search.
 *
 * The contract itself — payloads, channel names, the match rule, the safe projection — lives
 * in `@shared/model/import-plan.ts`, because both processes need it.
 */

export { ImportWizard, type ImportWizardProps } from './ImportWizard.js';

export { ImportGatewayError, IMPORT_ERROR_CODES, type ImportGateway } from './gateway.js';
export { createIpcImportGateway } from './ipc-gateway.js';

export {
  decisionFor,
  defaultDecisions,
  mergeReplacesPassword,
  recordsToAdd,
  summariseDecisions,
  DUPLICATE_ACTION_COPY,
  MERGE_EFFECT_COPY,
  type DuplicateSummary,
} from './duplicate-decisions.js';
export {
  groupWarnings,
  lossWarnings,
  totalWarnings,
  warningHeadline,
  type ImportWarningGroup,
  type ImportWarningSeverity,
} from './warning-groups.js';
export {
  generalIssues,
  issuesForColumn,
  mappingErrors,
  validateMapping,
  type MappingIssue,
  type MappingIssueSeverity,
} from './mapping-validation.js';
export {
  CONTENT_FIELD_TARGETS,
  FIELD_TARGET_COPY,
  SELECTABLE_FIELD_TARGETS,
  columnsWithTarget,
  customLabelFor,
  customTypeFor,
  targetFor,
  withCustomLabel,
  withCustomType,
  withTarget,
} from './field-targets.js';
export {
  IMPORT_STEPS,
  IMPORT_STEP_HEADINGS,
  IMPORT_STEP_STOPS,
  IMPORT_STOP_LABELS,
  canAdvance,
  importWizardReducer,
  initialImportWizardState,
  needsMapping,
  nextStep,
  previewIsCurrent,
  previousStep,
  stopFor,
  visibleStops,
  type ImportStep,
  type ImportStepStop,
  type ImportWizardAction,
  type ImportWizardState,
} from './wizard-machine.js';
