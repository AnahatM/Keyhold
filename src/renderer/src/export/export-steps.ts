// SPDX-License-Identifier: GPL-3.0-or-later

import type { ExportFormatDescriptor, ExportFormatId } from '@shared/model/export.js';
import {
  matchesPlaintextConfirmation,
  WHOLE_VAULT_SCOPE,
  type ExportPlan,
  type ExportScope,
} from '@shared/model/export-plan.js';

/**
 * The export dialog as a state machine, with no React in it.
 *
 * Everything that decides *whether the user may continue* lives here, as pure functions
 * over a plain draft object. That is not tidiness for its own sake: `@testing-library/react`
 * is not a dependency of this project, so a rule that lives inside a component is a rule
 * that is only tested by someone clicking it. The single most important rule in this
 * feature — a readable copy of the vault is never written without a typed confirmation — is
 * therefore expressed as {@link buildExportPlan} returning `null`, which a test can assert
 * exhaustively in a millisecond.
 *
 * The components below this file render a draft and call these functions. They decide
 * nothing.
 */

// ── Steps ────────────────────────────────────────────────────────────────────

/**
 * The four screens, in order.
 *
 * `result` is one of them rather than a separate mode, so the indicator can show where the
 * flow ends and so "go back" has exactly one meaning at every point. There is no step
 * between `confirm` and `result` for the write itself — that is a *status*, not a place the
 * user can be, and modelling a spinner as a step would let someone press Back into it.
 */
export const EXPORT_STEPS = ['format', 'scope', 'confirm', 'result'] as const;

export type ExportStep = (typeof EXPORT_STEPS)[number];

/** Exhaustive: a new step with no label is a compile error, not a blank indicator. */
export const EXPORT_STEP_LABELS: Readonly<Record<ExportStep, string>> = {
  format: 'Format',
  scope: 'What to include',
  confirm: 'Confirm',
  result: 'Done',
};

/**
 * Headings, which are not the same strings as the indicator labels.
 *
 * The indicator needs two words that fit in a chip; the heading names the question the step
 * is actually asking. Collapsing them would make one of the two worse.
 */
export const EXPORT_STEP_HEADINGS: Readonly<Record<ExportStep, string>> = {
  format: 'Choose a format',
  scope: 'Choose what to include',
  confirm: 'Confirm this export',
  result: 'Export finished',
};

export function stepIndex(step: ExportStep): number {
  return EXPORT_STEPS.indexOf(step);
}

export function nextStep(step: ExportStep): ExportStep | null {
  return EXPORT_STEPS[stepIndex(step) + 1] ?? null;
}

export function previousStep(step: ExportStep): ExportStep | null {
  const index = stepIndex(step);
  return index <= 0 ? null : (EXPORT_STEPS[index - 1] ?? null);
}

// ── The draft ────────────────────────────────────────────────────────────────

/**
 * Everything the user has entered, and nothing derived.
 *
 * Deliberately holds the raw typed strings rather than validity flags: a draft that stored
 * `confirmationValid: true` would be a place for the validity to be set once and then drift
 * from the text beside it. Validity is recomputed from this on every render, which is
 * cheap and cannot go stale.
 *
 * `secretPassphrase` and `passphraseRepeat` carry secret material and say so in their
 * names. They live in component state for the life of one dialog and are dropped when it
 * closes; see `resetDraft`.
 */
export interface ExportDraft {
  readonly formatId: ExportFormatId | null;
  readonly scope: ExportScope;
  /** Exactly what was typed into the type-to-confirm field. Never normalised in place. */
  readonly confirmation: string;
  readonly secretPassphrase: string;
  readonly passphraseRepeat: string;
}

/**
 * A draft with nothing chosen.
 *
 * No format is preselected. Preselecting one — even the safe one — puts a format into a
 * plan the user never picked, and the first step exists precisely to make that a choice.
 */
export function emptyDraft(): ExportDraft {
  return {
    formatId: null,
    scope: WHOLE_VAULT_SCOPE,
    confirmation: '',
    secretPassphrase: '',
    passphraseRepeat: '',
  };
}

// ── Gates ────────────────────────────────────────────────────────────────────

/** Whether the scope describes a set of records that could be exported at all. */
export function scopeIsUsable(scope: ExportScope): boolean {
  return scope.recordIds === null || scope.recordIds.length > 0;
}

/** The two passphrase fields agree and are not empty. Says nothing about strength. */
export function passphrasesAgree(draft: ExportDraft): boolean {
  return draft.secretPassphrase !== '' && draft.secretPassphrase === draft.passphraseRepeat;
}

/**
 * Whether the confirm step's requirement has been met, for whichever format is chosen.
 *
 * `passphraseStrongEnough` is passed in rather than read from the draft because it is an
 * answer from the main process, not something the user typed — and because a plaintext
 * export must not become blockable, or unblockable, by a strength estimate that has nothing
 * to do with it. For a plaintext format the argument is ignored entirely.
 */
export function confirmationSatisfied(
  draft: ExportDraft,
  descriptor: ExportFormatDescriptor,
  passphraseStrongEnough: boolean
): boolean {
  if (descriptor.encrypted) return passphrasesAgree(draft) && passphraseStrongEnough;
  return matchesPlaintextConfirmation(draft.confirmation);
}

/**
 * Whether the Continue button on a given step is enabled.
 *
 * `result` returns `false`: there is nowhere to continue to, and the footer shows Close
 * instead. Making that a value rather than a special case in the component keeps the
 * component free of decisions.
 */
export function canAdvance(
  step: ExportStep,
  draft: ExportDraft,
  descriptor: ExportFormatDescriptor | null,
  passphraseStrongEnough: boolean
): boolean {
  switch (step) {
    case 'format':
      return descriptor !== null;
    case 'scope':
      return descriptor !== null && scopeIsUsable(draft.scope);
    case 'confirm':
      return (
        descriptor !== null &&
        scopeIsUsable(draft.scope) &&
        confirmationSatisfied(draft, descriptor, passphraseStrongEnough)
      );
    case 'result':
      return false;
  }
}

// ── The plan ─────────────────────────────────────────────────────────────────

/**
 * Turns a draft into something the main process will accept, or refuses.
 *
 * **This is the guard.** There is exactly one way for the dialog to obtain an `ExportPlan`,
 * and it is this function; a plaintext plan cannot come out of it unless the confirmation
 * phrase was actually typed, and a parcel plan cannot come out of it without a non-empty
 * passphrase that was entered twice identically. A component that wanted to skip the
 * confirmation would have to construct the plan literal itself, which is a conspicuous
 * thing to find in review — and the main process would refuse it anyway, because it runs
 * `matchesPlaintextConfirmation` again on arrival.
 *
 * Strength is deliberately *not* checked here. A weak parcel passphrase is a bad idea the
 * dialog refuses to let you continue with (see {@link canAdvance}); it is not a malformed
 * request, and encoding a UX policy in the same function as a security invariant makes it
 * harder to see which of the two a future edit is weakening.
 */
export function buildExportPlan(
  draft: ExportDraft,
  descriptor: ExportFormatDescriptor
): ExportPlan | null {
  if (draft.formatId !== descriptor.id) return null;
  if (!scopeIsUsable(draft.scope)) return null;

  if (descriptor.encrypted) {
    if (descriptor.id !== 'keyhold-parcel') return null;
    if (!passphrasesAgree(draft)) return null;
    return {
      kind: 'encrypted',
      format: 'keyhold-parcel',
      scope: draft.scope,
      secretPassphrase: draft.secretPassphrase,
    };
  }

  if (!matchesPlaintextConfirmation(draft.confirmation)) return null;
  return {
    kind: 'plaintext',
    format: descriptor.id,
    scope: draft.scope,
    confirmation: draft.confirmation,
  };
}

// ── Leaving ──────────────────────────────────────────────────────────────────

/**
 * What the draft becomes when the dialog closes.
 *
 * A fresh object rather than a mutation, and it drops the passphrase and the confirmation
 * as a matter of course. React keeps component state alive across a close-and-reopen if the
 * component is not unmounted, and a dialog that reopened with `EXPORT UNENCRYPTED` already
 * in the field would have quietly turned the type-to-confirm into a button — which is
 * exactly the affordance this feature exists to refuse.
 *
 * It is also why there is no "remember this choice": a remembered plaintext format plus a
 * remembered confirmation is a one-click plaintext export, and the second time is when
 * people stop reading.
 */
export function resetDraft(): ExportDraft {
  return emptyDraft();
}
