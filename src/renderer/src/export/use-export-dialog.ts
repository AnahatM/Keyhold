// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ExportFormatDescriptor, ExportFormatId } from '@shared/model/export.js';
import type { ExportOutcome, ExportPreview } from '@shared/model/export-plan.js';
import type { PasswordStrength } from '@shared/model/strength.js';
import type { ExportGateway } from './export-gateway.js';
import {
  buildExportPlan,
  canAdvance,
  emptyDraft,
  nextStep,
  previousStep,
  type ExportDraft,
  type ExportStep,
} from './export-steps.js';

/**
 * The wiring between the pure step machine and the gateway.
 *
 * Everything here is plumbing: fetching, debouncing, cancelling stale responses, and moving
 * a step index. **No rule about what the user may do lives in this file** — every gate is a
 * call into `export-steps.ts`, so the rules can be tested without a renderer and cannot be
 * accidentally relaxed by a component that stops calling one.
 *
 * ## Two React constraints this file is written around
 *
 * **No `setState` in an effect body.** Every state change here happens inside a promise
 * continuation or a timer callback, never synchronously while an effect runs. The linter
 * enforces it; the reason is that a synchronous set in an effect is a second render pass
 * per effect, which for the preview would mean re-fetching on a render caused by the
 * previous fetch.
 *
 * **Every fetch is cancellable.** A user flicking through four formats fires four previews,
 * and without the `stale` flag the slowest one wins — which means the loss list on screen
 * could describe a format other than the one selected. That is not a cosmetic race: the
 * whole promise of this dialog is that the losses shown are the losses of the format about
 * to be written.
 */

/** Where the export itself is, as distinct from where the *user* is. */
export type ExportStatus = 'idle' | 'running';

export type ExportScopeMode = 'vault' | 'selection';

export interface ExportDialogController {
  readonly step: ExportStep;
  readonly draft: ExportDraft;
  readonly formats: readonly ExportFormatDescriptor[];
  readonly descriptor: ExportFormatDescriptor | null;
  readonly scopeMode: ExportScopeMode;
  readonly preview: ExportPreview | null;
  readonly previewing: boolean;
  readonly strength: PasswordStrength | null;
  readonly status: ExportStatus;
  readonly outcome: ExportOutcome | null;
  readonly error: string | null;
  readonly canContinue: boolean;
  readonly canGoBack: boolean;

  readonly chooseFormat: (id: ExportFormatId) => void;
  readonly setScopeMode: (mode: ExportScopeMode) => void;
  readonly setIncludeTrashed: (include: boolean) => void;
  readonly setConfirmation: (typed: string) => void;
  readonly setPassphrase: (typed: string) => void;
  readonly setPassphraseRepeat: (typed: string) => void;
  readonly goNext: () => void;
  readonly goBack: () => void;
}

/**
 * How long to wait after a keystroke before scoring a parcel passphrase.
 *
 * Exported because the mounted test has to outwait it: the parcel's Create button is gated
 * on a strength answer that only arrives after this timer, so a test that flushed only
 * microtasks would watch the button stay disabled and conclude the gate was broken. One
 * number, read by the hook and by the test that waits for it — not a `200` written twice.
 */
export const STRENGTH_DEBOUNCE_MS = 180;

export function useExportDialog(
  gateway: ExportGateway,
  /** Ids currently selected in the credential list. Empty means "selection" is unavailable. */
  selectedIds: readonly string[]
): ExportDialogController {
  const [step, setStep] = useState<ExportStep>('format');
  const [draft, setDraft] = useState<ExportDraft>(emptyDraft);
  const [formats, setFormats] = useState<readonly ExportFormatDescriptor[]>([]);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [strength, setStrength] = useState<PasswordStrength | null>(null);
  const [status, setStatus] = useState<ExportStatus>('idle');
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const descriptor = useMemo(
    () => formats.find((format) => format.id === draft.formatId) ?? null,
    [formats, draft.formatId]
  );

  // ── The format registry ────────────────────────────────────────────────────

  useEffect(() => {
    let stale = false;
    void gateway
      .formats()
      .then((available) => {
        if (!stale) setFormats(available);
      })
      .catch(() => {
        if (!stale) setError('Keyhold could not read the list of export formats.');
      });
    return () => {
      stale = true;
    };
  }, [gateway]);

  // ── The preview ────────────────────────────────────────────────────────────

  const { formatId, scope } = draft;

  useEffect(() => {
    if (formatId === null) return;
    let stale = false;

    // `setPreviewing(true)` would be a synchronous set in an effect body. A microtask defers
    // it past the effect without introducing a visible delay, and the stale flag means a
    // superseded request never turns the spinner back on.
    void Promise.resolve()
      .then(() => {
        if (!stale) setPreviewing(true);
        return gateway.preview({ format: formatId, scope });
      })
      .then((result) => {
        if (stale) return;
        setPreview(result);
        setPreviewing(false);
      })
      .catch(() => {
        if (stale) return;
        setPreview(null);
        setPreviewing(false);
        setError('Keyhold could not work out what this format would leave behind.');
      });

    return () => {
      stale = true;
    };
  }, [gateway, formatId, scope]);

  // ── The parcel passphrase meter ────────────────────────────────────────────

  const { secretPassphrase } = draft;

  useEffect(() => {
    let stale = false;
    // Debounced, so a dictionary pass does not run per keystroke and the meter does not
    // flicker mid-word. The empty case clears through the same timer rather than
    // synchronously, so there is one code path instead of two that can disagree.
    const timer = setTimeout(() => {
      if (secretPassphrase === '') {
        if (!stale) setStrength(null);
        return;
      }
      void gateway.estimateStrength(secretPassphrase).then((result) => {
        if (!stale) setStrength(result);
      });
    }, STRENGTH_DEBOUNCE_MS);

    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [gateway, secretPassphrase]);

  // ── Edits ──────────────────────────────────────────────────────────────────

  const chooseFormat = useCallback((id: ExportFormatId): void => {
    // Choosing a different format clears the confirmation and the passphrase. Carrying a
    // typed "EXPORT UNENCRYPTED" across a format change would let someone confirm one
    // format and export another — and carrying a passphrase into a plaintext format would
    // leave secret material in state for a flow that has no use for it.
    setDraft((current) => ({
      ...current,
      formatId: id,
      confirmation: '',
      secretPassphrase: '',
      passphraseRepeat: '',
    }));
    setStrength(null);
    setError(null);
  }, []);

  const setScopeMode = useCallback(
    (mode: ExportScopeMode): void => {
      setDraft((current) => ({
        ...current,
        scope: {
          includeTrashed: current.scope.includeTrashed,
          recordIds: mode === 'vault' ? null : [...selectedIds],
        },
      }));
    },
    [selectedIds]
  );

  const setIncludeTrashed = useCallback((include: boolean): void => {
    setDraft((current) => ({
      ...current,
      scope: { includeTrashed: include, recordIds: current.scope.recordIds },
    }));
  }, []);

  const setConfirmation = useCallback((typed: string): void => {
    setDraft((current) => ({ ...current, confirmation: typed }));
  }, []);

  const setPassphrase = useCallback((typed: string): void => {
    setDraft((current) => ({ ...current, secretPassphrase: typed }));
  }, []);

  const setPassphraseRepeat = useCallback((typed: string): void => {
    setDraft((current) => ({ ...current, passphraseRepeat: typed }));
  }, []);

  // ── Movement ───────────────────────────────────────────────────────────────

  const passphraseStrongEnough = strength?.meetsMasterMinimum === true;
  const canContinue =
    status === 'idle' && canAdvance(step, draft, descriptor, passphraseStrongEnough);
  const canGoBack = status === 'idle' && previousStep(step) !== null && step !== 'result';

  const runExport = useCallback((): void => {
    if (descriptor === null) return;
    const plan = buildExportPlan(draft, descriptor);
    // Not an assertion: `canAdvance` should already have prevented this, and if the two ever
    // disagree the safe answer is to do nothing rather than to export something.
    if (plan === null) return;

    setStatus('running');
    setError(null);
    void gateway
      .run(plan)
      .then((result) => {
        setStatus('idle');
        setOutcome(result);
        // A cancelled save dialog leaves the user exactly where they were, with everything
        // they typed intact. It is not a failure and it is not a result worth a screen.
        if (result.status === 'cancelled') return;
        setStep('result');
      })
      .catch(() => {
        setStatus('idle');
        setError('Keyhold could not write the export file.');
      });
  }, [gateway, draft, descriptor]);

  const goNext = useCallback((): void => {
    if (!canContinue) return;
    if (step === 'confirm') {
      runExport();
      return;
    }
    const next = nextStep(step);
    if (next !== null) setStep(next);
  }, [canContinue, step, runExport]);

  const goBack = useCallback((): void => {
    if (!canGoBack) return;
    const previous = previousStep(step);
    if (previous !== null) setStep(previous);
  }, [canGoBack, step]);

  const scopeMode: ExportScopeMode = draft.scope.recordIds === null ? 'vault' : 'selection';

  return {
    step,
    draft,
    formats,
    descriptor,
    scopeMode,
    preview,
    previewing,
    strength,
    status,
    outcome,
    error,
    canContinue,
    canGoBack,
    chooseFormat,
    setScopeMode,
    setIncludeTrashed,
    setConfirmation,
    setPassphrase,
    setPassphraseRepeat,
    goNext,
    goBack,
  };
}
