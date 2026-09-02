// SPDX-License-Identifier: GPL-3.0-or-later
import type { ColumnMapping, ImportFormatDescriptor } from '@shared/model/import.js';
import type {
  ImportCommitResult,
  ImportDuplicateAction,
  ImportPreview,
  ImportProgress,
  ImportSource,
  ImportUndoResult,
} from '@shared/model/import-plan.js';
import { defaultDecisions } from './duplicate-decisions.js';
import { mappingErrors } from './mapping-validation.js';

/**
 * The wizard's state, as a pure reducer.
 *
 * Every rule about *what happens next* lives here rather than in the component: which step
 * follows which, when the mapping step is skipped, what a format change invalidates, which
 * transitions are legal after a commit. That is what makes them testable — there is no
 * `@testing-library/react` in this project, so a step machine embedded in `useState` calls
 * inside JSX would be a set of rules nothing could assert.
 *
 * It also removes the failure this screen is most prone to: a stale preview. Changing the
 * format or the mapping **clears the preview and the plan id**, so the review step cannot
 * show numbers from a parse the user has since changed, and the commit cannot point at one.
 */

// ── Steps ────────────────────────────────────────────────────────────────────

export const IMPORT_STEPS = ['choose', 'format', 'map', 'review', 'importing', 'done'] as const;
export type ImportStep = (typeof IMPORT_STEPS)[number];

/**
 * The stops on the progress indicator.
 *
 * Fewer than the steps: `importing` and `done` are one stop, because a user does not think
 * of "watching the bar" and "reading the result" as two places they went. An indicator that
 * grows a stop the moment work starts is an indicator that moved the goalposts.
 */
export const IMPORT_STEP_STOPS = ['choose', 'format', 'map', 'review', 'import'] as const;
export type ImportStepStop = (typeof IMPORT_STEP_STOPS)[number];

export const IMPORT_STOP_LABELS: Readonly<Record<ImportStepStop, string>> = {
  choose: 'Choose a file',
  format: 'Confirm the format',
  map: 'Map columns',
  review: 'Review',
  import: 'Import',
};

/** The `<h3>` each step announces itself with, and moves focus to. */
export const IMPORT_STEP_HEADINGS: Readonly<Record<ImportStep, string>> = {
  choose: 'Choose a file to import',
  format: 'Confirm the format',
  map: 'Map the columns',
  review: 'Review what will be imported',
  importing: 'Importing',
  done: 'Import finished',
};

export function stopFor(step: ImportStep): ImportStepStop {
  return step === 'importing' || step === 'done' ? 'import' : step;
}

// ── State ────────────────────────────────────────────────────────────────────

export interface ImportWizardState {
  readonly step: ImportStep;
  readonly formats: readonly ImportFormatDescriptor[];
  readonly source: ImportSource | null;
  readonly formatId: string | null;
  /** Only meaningful for a format that needs one. `null` until a source is chosen. */
  readonly mapping: ColumnMapping | null;
  /** Cleared whenever the format or the mapping changes — see the note at the top. */
  readonly preview: ImportPreview | null;
  /** Match key → what to do. Survives a re-preview for any group that still exists. */
  readonly decisions: Readonly<Record<string, ImportDuplicateAction>>;
  readonly progress: ImportProgress | null;
  readonly result: ImportCommitResult | null;
  readonly undoResult: ImportUndoResult | null;
  readonly busy: boolean;
  readonly error: string | null;
}

export const initialImportWizardState: ImportWizardState = {
  step: 'choose',
  formats: [],
  source: null,
  formatId: null,
  mapping: null,
  preview: null,
  decisions: {},
  progress: null,
  result: null,
  undoResult: null,
  busy: false,
  error: null,
};

// ── Derived questions ────────────────────────────────────────────────────────

export function formatById(
  state: ImportWizardState,
  formatId: string | null
): ImportFormatDescriptor | null {
  if (formatId === null) return null;
  return state.formats.find((format) => format.id === formatId) ?? null;
}

export function selectedFormat(state: ImportWizardState): ImportFormatDescriptor | null {
  return formatById(state, state.formatId);
}

/** True when the chosen format is the catch-all whose mapping the user supplies. */
export function needsMapping(state: ImportWizardState): boolean {
  return selectedFormat(state)?.needsMapping ?? false;
}

/**
 * The stops to draw, in order.
 *
 * "Map columns" is omitted rather than disabled when the format does not need one. A greyed
 * stop that never becomes reachable tells the user the flow is longer than it is, and the
 * count in "step 2 of 5" would be a lie for nine of the eleven formats.
 */
export function visibleStops(state: ImportWizardState): readonly ImportStepStop[] {
  return IMPORT_STEP_STOPS.filter((stop) => stop !== 'map' || needsMapping(state));
}

export function nextStep(state: ImportWizardState): ImportStep | null {
  switch (state.step) {
    case 'choose':
      return state.source === null ? null : 'format';
    case 'format':
      return state.formatId === null ? null : needsMapping(state) ? 'map' : 'review';
    case 'map':
      return 'review';
    case 'review':
      return state.preview === null ? null : 'importing';
    case 'importing':
    case 'done':
      return null;
  }
}

/**
 * `null` once the commit has started.
 *
 * There is no back from a write. Offering one would imply the import could be un-started,
 * which it cannot — undo is a separate, explicit action on the result step, and conflating
 * the two is how a user ends up thinking they cancelled something that already ran.
 */
export function previousStep(state: ImportWizardState): ImportStep | null {
  switch (state.step) {
    case 'choose':
    case 'importing':
    case 'done':
      return null;
    case 'format':
      return 'choose';
    case 'map':
      return 'format';
    case 'review':
      return needsMapping(state) ? 'map' : 'format';
  }
}

/** Whether the primary button on this step can do anything yet. */
export function canAdvance(state: ImportWizardState): boolean {
  if (state.busy) return false;
  switch (state.step) {
    case 'choose':
      return state.source !== null;
    case 'format':
      return state.formatId !== null;
    case 'map':
      return state.mapping !== null && mappingErrors(state.mapping).length === 0;
    case 'review':
      return state.preview !== null;
    case 'importing':
    case 'done':
      return false;
  }
}

/**
 * True when the review step is showing numbers that still describe the current choices.
 *
 * The component reads this to decide whether to render the dry run or a "run it again"
 * prompt; without it a mapping change would leave last parse's counts on screen looking
 * authoritative.
 */
export function previewIsCurrent(state: ImportWizardState): boolean {
  const preview = state.preview;
  if (preview === null || state.source === null) return false;
  return preview.sourceId === state.source.sourceId && preview.formatId === state.formatId;
}

// ── Actions ──────────────────────────────────────────────────────────────────

export type ImportWizardAction =
  | { readonly type: 'formats-loaded'; readonly formats: readonly ImportFormatDescriptor[] }
  | { readonly type: 'source-chosen'; readonly source: ImportSource }
  | { readonly type: 'format-chosen'; readonly formatId: string }
  | { readonly type: 'mapping-changed'; readonly mapping: ColumnMapping }
  | { readonly type: 'preview-loaded'; readonly preview: ImportPreview }
  | {
      readonly type: 'decision-changed';
      readonly key: string;
      readonly action: ImportDuplicateAction;
    }
  | { readonly type: 'decisions-set-all'; readonly action: ImportDuplicateAction }
  | { readonly type: 'go-to'; readonly step: ImportStep }
  | { readonly type: 'progress'; readonly progress: ImportProgress }
  | { readonly type: 'committed'; readonly result: ImportCommitResult }
  | { readonly type: 'undone'; readonly undoResult: ImportUndoResult }
  | { readonly type: 'busy'; readonly busy: boolean }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'reset' };

export function importWizardReducer(
  state: ImportWizardState,
  action: ImportWizardAction
): ImportWizardState {
  switch (action.type) {
    case 'formats-loaded':
      return { ...state, formats: action.formats };

    case 'source-chosen':
      // A new file invalidates everything downstream of it. Merging the new source into the
      // old preview is exactly how a wizard ends up importing the file the user replaced.
      return {
        ...state,
        step: 'format',
        source: action.source,
        formatId: action.source.detectedFormatId,
        mapping: action.source.inferredMapping,
        preview: null,
        decisions: {},
        result: null,
        undoResult: null,
        progress: null,
        error: null,
      };

    case 'format-chosen': {
      if (action.formatId === state.formatId) return state;
      const next: ImportWizardState = { ...state, formatId: action.formatId, preview: null };
      // The inferred mapping belongs to the file, not to the format, so it is restored
      // rather than discarded when the user switches back to the generic parser.
      return {
        ...next,
        mapping: needsMapping(next)
          ? (state.mapping ?? state.source?.inferredMapping ?? null)
          : null,
        error: null,
      };
    }

    case 'mapping-changed':
      return { ...state, mapping: action.mapping, preview: null, error: null };

    case 'preview-loaded':
      return {
        ...state,
        preview: action.preview,
        // Decisions the user already made are kept for any group that still exists; groups
        // that appeared because the mapping changed take the safe default.
        decisions: defaultDecisions(action.preview.duplicates, state.decisions),
        error: null,
      };

    case 'decision-changed':
      return { ...state, decisions: { ...state.decisions, [action.key]: action.action } };

    case 'decisions-set-all': {
      const decisions: Record<string, ImportDuplicateAction> = {};
      for (const group of state.preview?.duplicates ?? []) decisions[group.key] = action.action;
      return { ...state, decisions };
    }

    case 'go-to':
      return { ...state, step: action.step, error: null };

    case 'progress':
      return { ...state, progress: action.progress };

    case 'committed':
      return { ...state, step: 'done', result: action.result, busy: false, progress: null };

    case 'undone':
      return { ...state, undoResult: action.undoResult, busy: false };

    case 'busy':
      return { ...state, busy: action.busy };

    case 'failed':
      // A failure never advances a step and never clears the preview: the user should land
      // back on the control they were using, with the numbers they were reading still there.
      return { ...state, error: action.message, busy: false, progress: null };

    case 'reset':
      return { ...initialImportWizardState, formats: state.formats };
  }
}
