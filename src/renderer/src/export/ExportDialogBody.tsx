// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useId, useRef } from 'react';
import { PLAINTEXT_EXPORT_WARNING } from '@shared/model/export.js';
import { Button } from '../components/Button.js';
import { Modal, ProgressBar } from '../chrome/index.js';
import { EXPORT_STEP_HEADINGS } from './export-steps.js';
import { ExportFormatStep } from './ExportFormatStep.js';
import { ExportResultStep } from './ExportResultStep.js';
import { ExportScopeStep } from './ExportScopeStep.js';
import type { ExportGateway } from './export-gateway.js';
import { ParcelConfirm } from './ParcelConfirm.js';
import { PlaintextConfirm } from './PlaintextConfirm.js';
import { StepIndicator } from './StepIndicator.js';
import { useExportDialog, type ExportDialogController } from './use-export-dialog.js';
import './export.css';
import { Icon } from '../components/Icon.js';

/**
 * The export dialog itself, mounted only while it is open.
 *
 * ## Why this is a separate component from `ExportDialog`
 *
 * Unmounting is how the passphrase and the typed confirmation are destroyed. React keeps
 * component state alive for as long as the component is mounted, so a dialog that merely
 * hid itself on close would reopen with `EXPORT UNENCRYPTED` still sitting in the field —
 * which would have turned the type-to-confirm into a button, for the second export onwards.
 * The wrapper renders this only while open; there is no reset path to forget to call.
 *
 * ## Focus
 *
 * Focus moves to the current step's heading on every step change, not into the first field.
 * On the confirm step that is the whole point: the heading is above the warning and the
 * loss list, so a keyboard or screen-reader user arrives *before* the things they are meant
 * to read rather than after them. The heading takes `tabIndex={-1}` so it can receive
 * programmatic focus without joining the tab order.
 *
 * ## Closing
 *
 * Every step can be cancelled and none of them changes anything — the dialog holds a draft,
 * and the main process is not asked to do anything until the confirm step's button is
 * pressed. The one moment close is refused is while a write is in flight: there is nothing
 * useful to cancel by then (the bytes are the main process's) and dismissing the dialog
 * would hide the report of a file that had just been written.
 */
export interface ExportDialogBodyProps {
  readonly gateway: ExportGateway;
  /** Records selected in the credential list, for the "only these" scope. */
  readonly selectedIds: readonly string[];
  readonly onClose: () => void;
}

/** Resolved inside the dialog by `Modal`, so the first focus matches every later one. */
const HEADING_SELECTOR = '.kh-export-step__heading';

export function ExportDialogBody({
  gateway,
  selectedIds,
  onClose,
}: ExportDialogBodyProps): React.JSX.Element {
  const controller = useExportDialog(gateway, selectedIds);
  const { step, draft, descriptor, preview, status, outcome, error } = controller;

  const headingRef = useRef<HTMLHeadingElement>(null);
  const descriptionId = useId();

  // A DOM call, not a state update — so it is allowed in an effect body, unlike the
  // fetches in `use-export-dialog.ts`. Runs on every step change and on mount; on mount
  // `Modal` re-applies the same target through `initialFocusSelector`, so the two agree.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const requestClose = useCallback((): void => {
    if (status === 'running') return;
    onClose();
  }, [status, onClose]);

  const plaintext = descriptor !== null && !descriptor.encrypted;
  const running = status === 'running';

  return (
    <Modal
      open
      title="Export"
      onClose={requestClose}
      size="lg"
      // There is a passphrase in here. A stray click on the backdrop must not discard it.
      closeOnBackdropClick={false}
      initialFocusSelector={HEADING_SELECTOR}
      footer={
        <ExportFooter
          controller={controller}
          plaintext={plaintext}
          running={running}
          onClose={requestClose}
        />
      }
    >
      <StepIndicator current={step} label="Export progress" />

      <h3 className="kh-export-step__heading" ref={headingRef} tabIndex={-1}>
        {EXPORT_STEP_HEADINGS[step]}
      </h3>

      {error !== null && (
        <p className="kh-export-note kh-export-note--danger" role="alert">
          <Icon name="warning" size="sm" />
          {error}
        </p>
      )}

      {outcome?.status === 'cancelled' && step === 'confirm' && (
        <p className="kh-export-note" role="status">
          The save dialog was closed, so nothing was written. Everything you chose is still here.
        </p>
      )}

      {step === 'format' && (
        <>
          <p className="kh-export-step__lead" id={descriptionId}>
            Every format below is produced by Keyhold itself. Only the first one is encrypted; the
            rest write your passwords in text anyone can read.
          </p>
          <ExportFormatStep
            formats={controller.formats}
            selectedId={draft.formatId}
            preview={preview}
            onChoose={controller.chooseFormat}
            describedById={descriptionId}
          />
        </>
      )}

      {step === 'scope' && (
        <>
          <p className="kh-export-step__lead" id={descriptionId}>
            Choose how much of the vault goes into the file. The counts update as you change this.
          </p>
          <ExportScopeStep
            scope={draft.scope}
            mode={controller.scopeMode}
            selectionCount={selectedIds.length}
            preview={preview}
            previewing={controller.previewing}
            onModeChange={controller.setScopeMode}
            onIncludeTrashedChange={controller.setIncludeTrashed}
            describedById={descriptionId}
          />
        </>
      )}

      {step === 'confirm' && descriptor !== null && (
        <>
          {descriptor.encrypted ? (
            <ParcelConfirm
              passphrase={draft.secretPassphrase}
              repeat={draft.passphraseRepeat}
              strength={controller.strength}
              losses={preview?.losses ?? []}
              onPassphraseChange={controller.setPassphrase}
              onRepeatChange={controller.setPassphraseRepeat}
            />
          ) : (
            <PlaintextConfirm
              // The engine's own constant, passed straight through. It is a constant so
              // that no second caller can soften it, and it is passed rather than imported
              // by `PlaintextConfirm` so that the one place deciding a step is dangerous is
              // the one place that supplies the sentence saying so.
              warning={PLAINTEXT_EXPORT_WARNING}
              typed={draft.confirmation}
              losses={preview?.losses ?? []}
              onChange={controller.setConfirmation}
            />
          )}

          {running && (
            <ProgressBar
              label={descriptor.encrypted ? 'Sealing your parcel' : 'Writing your export'}
              note="Keyhold is asking your operating system where to put the file."
              {...(descriptor.encrypted
                ? {
                    slowNote:
                      'Argon2id is deliberately slow — that is what makes the parcel expensive to attack.',
                  }
                : {})}
            />
          )}
        </>
      )}

      {step === 'result' && outcome !== null && <ExportResultStep outcome={outcome} />}
    </Modal>
  );
}

interface ExportFooterProps {
  readonly controller: ExportDialogController;
  readonly plaintext: boolean;
  readonly running: boolean;
  readonly onClose: () => void;
}

/**
 * The footer, whose only interesting decision is the label on the primary button.
 *
 * On the confirm step it names the verb and the danger — "Export unencrypted", in the
 * danger variant — because a label someone can read out of context is the last chance to
 * notice they are on the wrong dialog. "OK" would throw that away.
 */
function ExportFooter({
  controller,
  plaintext,
  running,
  onClose,
}: ExportFooterProps): React.JSX.Element {
  const { step, canContinue, canGoBack } = controller;

  if (step === 'result') {
    return (
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    );
  }

  const label =
    step === 'confirm' ? (plaintext ? 'Export unencrypted' : 'Create parcel') : 'Continue';

  return (
    <>
      <Button variant="ghost" onClick={onClose} disabled={running}>
        Cancel
      </Button>
      <Button variant="secondary" onClick={controller.goBack} disabled={!canGoBack}>
        Back
      </Button>
      <Button
        variant={step === 'confirm' && plaintext ? 'danger' : 'primary'}
        onClick={controller.goNext}
        disabled={!canContinue}
        loading={running}
      >
        {label}
      </Button>
    </>
  );
}
