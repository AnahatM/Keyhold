// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ColumnMapping } from '@shared/model/import.js';
import {
  IMPORT_SAMPLE_SIZE,
  type ImportCommitResult,
  type ImportDuplicateAction,
  type ImportPreviewRequest,
} from '@shared/model/import-plan.js';
import { Modal } from '../chrome/index.js';
import { Button } from '../components/Button.js';
import { Icon } from '../components/Icon.js';
import { ChooseFileStep } from './ChooseFileStep.js';
import { ChooseFormatStep } from './ChooseFormatStep.js';
import { recordsToAdd } from './duplicate-decisions.js';
import type { ImportGateway } from './gateway.js';
import { ImportProgressPanel } from './ImportProgressPanel.js';
import { ImportResultPanel } from './ImportResultPanel.js';
import { ImportStepper } from './ImportStepper.js';
import { MapColumnsStep } from './MapColumnsStep.js';
import { ReviewStep } from './ReviewStep.js';
import {
  canAdvance,
  IMPORT_STEP_HEADINGS,
  importWizardReducer,
  initialImportWizardState,
  needsMapping,
  nextStep,
  previewIsCurrent,
  previousStep,
  stopFor,
  visibleStops,
  type ImportStep,
  type ImportWizardState,
} from './wizard-machine.js';
import './import.css';

/**
 * The import wizard.
 *
 * Five steps, one gateway, and one rule underneath all of it: **nothing is written until the
 * user has seen what would be written.** Every step before the commit is a read, the commit
 * is a single explicit action, and the step after it offers undo.
 *
 * ## What this component is and is not responsible for
 *
 * It owns *orchestration* — which async call belongs to which button, where focus goes, when
 * the preview is refreshed — and nothing else. The rules about which step follows which live
 * in `wizard-machine.ts`, the dedupe arithmetic in `duplicate-decisions.ts`, the warning
 * grouping in `warning-groups.ts`, the mapping rules in `mapping-validation.ts`. That split
 * is not tidiness: `@testing-library/react` is not a dependency here, so anything expressed
 * as JSX-embedded state is a rule that cannot be asserted. Everything worth asserting is a
 * pure function, and this file is the thin part that is left.
 *
 * ## Cancelling changes nothing
 *
 * There is no path out of this component that does not call `gateway.discard`. Closing the
 * modal, pressing Escape, pressing Cancel and finishing all route through `close()`, which
 * drops the file, every parse of it and every plan derived from it. Before the commit that
 * means the vault is untouched; after it, the file the main process was holding — a plaintext
 * dump of somebody's passwords — stops being held.
 */
export interface ImportWizardProps {
  readonly open: boolean;
  readonly gateway: ImportGateway;
  readonly onClose: () => void;
  /** Fires after a successful commit, so the vault list can refresh itself. */
  readonly onImported?: (result: ImportCommitResult) => void;
}

/**
 * How long to wait after a mapping change before re-parsing.
 *
 * The mapping step re-runs the *real* parse on every change so the sample underneath is
 * honest. Typing a custom label is several changes a second, and each one is a full parse of
 * the file in the main process — so the keystrokes are coalesced. Short enough that the table
 * feels attached to the control, long enough that a typed word is one parse and not seven.
 *
 * Exported because `ImportWizard.test.tsx` has to outwait it to see the sample table the
 * mapping step is judged on. One number, read by the wizard and by the test that waits for
 * it — not a `300` written down twice and left to drift.
 */
export const PREVIEW_DEBOUNCE_MS = 250;

export function ImportWizard({
  open,
  gateway,
  onClose,
  onImported,
}: ImportWizardProps): React.JSX.Element {
  const [state, dispatch] = useReducer(importWizardReducer, initialImportWizardState);
  const headingRef = useRef<HTMLHeadingElement>(null);

  /**
   * Which preview request is the current one.
   *
   * Two previews can be in flight when the user edits the mapping quickly, and they can
   * finish out of order. Without this the older answer would land last and the sample table
   * would show a mapping the user has already changed — the exact dishonesty the live sample
   * exists to prevent.
   */
  const previewSequence = useRef(0);

  const failure = useCallback((error: unknown): void => {
    const message =
      error instanceof Error
        ? error.message
        : 'Something went wrong reading that file. Nothing has been changed.';
    dispatch({ type: 'failed', message });
  }, []);

  // ── Format registry ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // A promise chain rather than an immediately-invoked async function, matching
    // `use-export-dialog.ts`. The IIFE form is narrowed by TypeScript to the `false` it was
    // initialised with — it cannot see the cleanup assigning it — so `if (!cancelled)` reads
    // as provably-true and the guard silently stops being a guard.
    void gateway
      .listFormats()
      .then((formats) => {
        if (!cancelled) dispatch({ type: 'formats-loaded', formats });
      })
      .catch((error: unknown) => {
        if (!cancelled) failure(error);
      });
    return () => {
      cancelled = true;
    };
  }, [open, gateway, failure]);

  // ── Progress ───────────────────────────────────────────────────────────────

  useEffect(
    () =>
      gateway.onProgress((progress) => {
        dispatch({ type: 'progress', progress });
      }),
    [gateway]
  );

  // ── Focus follows the step ─────────────────────────────────────────────────

  useEffect(() => {
    // WCAG 2.4.3. A wizard that swaps its body without moving focus leaves a keyboard user
    // on a button that no longer exists and a screen-reader user hearing nothing at all —
    // the content changed and, as far as assistive tech is concerned, nothing happened.
    headingRef.current?.focus();
  }, [state.step]);

  // ── The preview ────────────────────────────────────────────────────────────

  /** Returns whether a fresh preview landed — the dry run is a gate, so the answer matters. */
  const refreshPreview = useCallback(async (): Promise<boolean> => {
    const source = state.source;
    const formatId = state.formatId;
    if (source === null || formatId === null) return false;

    const sequence = previewSequence.current + 1;
    previewSequence.current = sequence;
    dispatch({ type: 'busy', busy: true });

    const request: ImportPreviewRequest = {
      sourceId: source.sourceId,
      formatId,
      sampleSize: IMPORT_SAMPLE_SIZE,
      // Omitted rather than set to undefined: `exactOptionalPropertyTypes` is on, and an
      // explicit undefined would not be assignable to `mapping?: ColumnMapping`.
      ...(state.mapping === null ? {} : { mapping: state.mapping }),
    };

    try {
      const preview = await gateway.preview(request);
      if (previewSequence.current !== sequence) return false;
      dispatch({ type: 'preview-loaded', preview });
      dispatch({ type: 'busy', busy: false });
      return true;
    } catch (error) {
      if (previewSequence.current !== sequence) return false;
      failure(error);
      return false;
    }
  }, [gateway, state.source, state.formatId, state.mapping, failure]);

  useEffect(() => {
    if (state.step !== 'map') return;
    // The dispatch happens inside the timer, never in the effect body — a synchronous state
    // update from an effect is both a lint error here and a render the user pays for.
    const timer = window.setTimeout(() => {
      void refreshPreview();
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [state.step, refreshPreview]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const chooseFile = useCallback(async (): Promise<void> => {
    dispatch({ type: 'busy', busy: true });
    try {
      const source = await gateway.chooseFile();
      // `null` is a cancelled dialog, not a failure. Saying "no file was chosen" to someone
      // who deliberately pressed Cancel is the app arguing with them.
      if (source !== null) dispatch({ type: 'source-chosen', source });
      dispatch({ type: 'busy', busy: false });
    } catch (error) {
      failure(error);
    }
  }, [gateway, failure]);

  const openVault = useCallback(
    async (secretPassphrase: string): Promise<void> => {
      dispatch({ type: 'busy', busy: true });
      try {
        const source = await gateway.openVault(secretPassphrase);
        // Same rule as `chooseFile`: `null` is a cancelled dialog, not a failure. A wrong
        // passphrase throws and lands in the error slot, because those are different answers.
        if (source !== null) dispatch({ type: 'source-chosen', source });
        dispatch({ type: 'busy', busy: false });
      } catch (error) {
        failure(error);
      }
    },
    [gateway, failure]
  );

  const advance = useCallback(async (): Promise<void> => {
    const target = nextStep(state);
    if (target === null) return;

    if (target === 'review' && !previewIsCurrent(state)) {
      // The dry run is the gate. If it failed there is nothing to review, so the user stays
      // where they are with the error next to the control that caused it — moving on would
      // show them an empty review screen as though it were an answer.
      if (await refreshPreview()) dispatch({ type: 'go-to', step: 'review' });
      return;
    }

    if (target === 'importing') {
      const preview = state.preview;
      if (preview === null) return;
      dispatch({ type: 'go-to', step: 'importing' });
      dispatch({ type: 'busy', busy: true });
      try {
        const result = await gateway.commit({
          planId: preview.planId,
          duplicateActions: state.decisions,
        });
        dispatch({ type: 'committed', result });
        onImported?.(result);
      } catch (error) {
        // A failed commit lands back on the review step with its numbers intact, so the
        // user can read the error next to the thing it is about and try again.
        dispatch({ type: 'go-to', step: 'review' });
        failure(error);
      }
      return;
    }

    dispatch({ type: 'go-to', step: target });
  }, [state, gateway, refreshPreview, failure, onImported]);

  const undo = useCallback(async (): Promise<void> => {
    const result = state.result;
    if (result === null) return;
    dispatch({ type: 'busy', busy: true });
    try {
      const undoResult = await gateway.undo({
        batchId: result.batchId,
        expectedVaultGeneration: result.vaultGeneration,
      });
      dispatch({ type: 'undone', undoResult });
      onImported?.(result);
    } catch (error) {
      failure(error);
    }
  }, [gateway, state.result, onImported, failure]);

  const close = useCallback((): void => {
    const sourceId = state.source?.sourceId;
    if (sourceId !== undefined) {
      // Fire and forget, but never unhandled: the wizard is closing either way, and a failed
      // cleanup is the main process's problem to log, not a dialog to trap the user in.
      void gateway.discard(sourceId).catch(() => undefined);
    }
    dispatch({ type: 'reset' });
    onClose();
  }, [gateway, state.source, onClose]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const stops = visibleStops(state);
  const back = previousStep(state);
  const additions =
    state.preview === null
      ? 0
      : recordsToAdd(state.preview.newRecordCount, state.preview.duplicates, state.decisions);

  return (
    <Modal
      open={open}
      title="Import into your vault"
      description="Nothing is written until you have seen exactly what would be written."
      size="lg"
      // Off, because this dialog holds a decision in progress. A stray click on the backdrop
      // discarding a mapping someone spent five minutes on is not a close, it is a loss.
      closeOnBackdropClick={false}
      onClose={close}
    >
      <div className="kh-import">
        <ImportStepper stops={stops} current={stopFor(state.step)} />

        {/*
         * `tabIndex={-1}` makes the heading programmatically focusable without putting it in
         * the tab order — so focus can be moved here on each transition and the next Tab
         * still lands on the first real control of the new step.
         */}
        <h3 className="kh-import__heading" tabIndex={-1} ref={headingRef}>
          {IMPORT_STEP_HEADINGS[state.step]}
        </h3>

        {state.error !== null && (
          <p className="kh-import-error" role="alert">
            <Icon name="warning" /> {state.error}
          </p>
        )}

        <StepBody
          state={state}
          onChooseFile={() => {
            void chooseFile();
          }}
          onOpenVault={(secretPassphrase) => {
            void openVault(secretPassphrase);
          }}
          onFormat={(formatId) => {
            dispatch({ type: 'format-chosen', formatId });
          }}
          onMapping={(mapping) => {
            dispatch({ type: 'mapping-changed', mapping });
          }}
          onDecision={(key, action) => {
            dispatch({ type: 'decision-changed', key, action });
          }}
          onDecideAll={(action) => {
            dispatch({ type: 'decisions-set-all', action });
          }}
          onUndo={() => {
            void undo();
          }}
        />

        <div className="kh-import__footer">
          {back !== null && (
            <Button
              variant="ghost"
              disabled={state.busy}
              onClick={() => {
                dispatch({ type: 'go-to', step: back });
              }}
            >
              Back
            </Button>
          )}

          <span className="kh-import__spacer" />

          {state.step !== 'importing' && (
            <Button variant="secondary" onClick={close}>
              {state.step === 'done' ? 'Close' : 'Cancel'}
            </Button>
          )}

          {state.step !== 'done' && state.step !== 'importing' && (
            <Button
              variant="primary"
              loading={state.busy}
              disabled={!canAdvance(state)}
              onClick={() => {
                void advance();
              }}
            >
              {primaryLabel(state.step, needsMapping(state), additions)}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function primaryLabel(step: ImportStep, mapping: boolean, additions: number): string {
  switch (step) {
    case 'choose':
      return 'Continue';
    case 'format':
      return mapping ? 'Map the columns' : 'Run the dry run';
    case 'map':
      return 'Run the dry run';
    case 'review':
      // The button says the number. "Import" is a verb with no consequences attached; "Import
      // 412 records" is a description of what is about to happen to the user's vault.
      return `Import ${additions} ${additions === 1 ? 'record' : 'records'}`;
    case 'importing':
    case 'done':
      return 'Continue';
  }
}

function StepBody({
  state,
  onChooseFile,
  onOpenVault,
  onFormat,
  onMapping,
  onDecision,
  onDecideAll,
  onUndo,
}: {
  readonly state: ImportWizardState;
  readonly onChooseFile: () => void;
  readonly onOpenVault: (secretPassphrase: string) => void;
  readonly onFormat: (formatId: string) => void;
  readonly onMapping: (mapping: ColumnMapping) => void;
  readonly onDecision: (key: string, action: ImportDuplicateAction) => void;
  readonly onDecideAll: (action: ImportDuplicateAction) => void;
  readonly onUndo: () => void;
}): React.JSX.Element | null {
  switch (state.step) {
    case 'choose':
      return (
        <ChooseFileStep
          source={state.source}
          busy={state.busy}
          onChoose={onChooseFile}
          onOpenVault={onOpenVault}
        />
      );

    case 'format':
      if (state.source === null) return null;
      return (
        <ChooseFormatStep
          source={state.source}
          formats={state.formats}
          formatId={state.formatId}
          onChange={onFormat}
        />
      );

    case 'map':
      if (state.source === null || state.mapping === null) return null;
      return (
        <MapColumnsStep
          columns={state.source.columns}
          mapping={state.mapping}
          sample={state.preview?.sample ?? []}
          onChange={onMapping}
        />
      );

    case 'review':
      if (state.preview === null) return null;
      return (
        <ReviewStep
          preview={state.preview}
          decisions={state.decisions}
          onDecision={onDecision}
          onDecideAll={onDecideAll}
        />
      );

    case 'importing':
      return <ImportProgressPanel progress={state.progress} />;

    case 'done':
      if (state.result === null) return null;
      return (
        <ImportResultPanel
          result={state.result}
          undoResult={state.undoResult}
          busy={state.busy}
          onUndo={onUndo}
        />
      );
  }
}
