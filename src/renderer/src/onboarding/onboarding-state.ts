// SPDX-License-Identifier: GPL-3.0-or-later
import type { PasswordStrength } from '@shared/model/strength.js';
import {
  canonicalStepFor,
  FIRST_STEP_ID,
  isLastStep,
  nextStepId,
  previousStepId,
  stepIndex,
  type OnboardingStepId,
} from './onboarding-steps.js';

/**
 * The first-run flow's model: what it remembers, and the rules about what may happen next.
 *
 * Pure — no React, no DOM, no storage, no clock. That is deliberate and it is the whole
 * reason the interesting guarantees in this flow are testable at all: `@testing-library/react`
 * is not a dependency of this project, so anything expressed only as component behaviour is
 * effectively unguarded. The gate that matters most here — **a vault is never created
 * without an explicit acknowledgement that there is no recovery** — lives in
 * {@link canCreateVault} and {@link canFinishOnboarding}, where a test can hold it still.
 *
 * ## What is deliberately NOT in this state
 *
 * Anything the user typed. No password, no confirmation, no credential draft. Those live in
 * the component that owns the field, for exactly as long as the field is on screen, and
 * this state — which is the thing that gets persisted — never sees them. See
 * `onboarding-storage.ts`.
 */

export type OnboardingOutcome = 'active' | 'completed' | 'dismissed';

export interface OnboardingState {
  readonly stepId: OnboardingStepId;
  /**
   * The user has ticked the no-recovery acknowledgement.
   *
   * Persisted, because it records a **decision** rather than content: someone who
   * acknowledged the warning, created a vault, and then closed the app mid-flow has already
   * been told, and re-gating them on resume would be friction with nothing behind it. The
   * warning itself is still on the step when they return.
   */
  readonly acknowledgedNoRecovery: boolean;
  /** A vault has actually been created through this flow. */
  readonly vaultCreated: boolean;
  /** The optional first credential was saved. Never a gate — only used for the summary. */
  readonly firstCredentialSaved: boolean;
  readonly outcome: OnboardingOutcome;
}

export const INITIAL_ONBOARDING_STATE: OnboardingState = {
  stepId: FIRST_STEP_ID,
  acknowledgedNoRecovery: false,
  vaultCreated: false,
  firstCredentialSaved: false,
  outcome: 'active',
};

/**
 * What the host is handed when the optional first credential is saved.
 *
 * `secretPassword` carries the naming convention this codebase uses for anything holding
 * secret material, so a reviewer can see at a glance that this object must not be logged,
 * persisted, or put anywhere that outlives the call.
 */
export interface FirstCredentialDraft {
  readonly title: string;
  readonly username: string;
  readonly url: string;
  readonly secretPassword: string;
}

export type OnboardingAction =
  | { readonly type: 'acknowledge'; readonly value: boolean }
  | { readonly type: 'vault-created' }
  | { readonly type: 'first-credential-saved' }
  | { readonly type: 'advance' }
  | { readonly type: 'back' }
  | { readonly type: 'complete' }
  | { readonly type: 'dismiss' };

/**
 * Whether the vault may be created from what is currently on the master-password step.
 *
 * **This is the acknowledgement gate.** Creating the vault is the irreversible act — it is
 * the moment a password the user may not remember becomes the only key to data they are
 * about to put in — so every condition is checked here rather than spread across the form's
 * rendering.
 *
 * `meetsMasterMinimum` comes from the main process's estimator and is never re-derived. A
 * second, weaker local definition of "strong enough" is precisely the failure
 * `src/main/session/strength.ts` exists to prevent: it uses zxcvbn plus a length floor, and
 * it deliberately rejects passwords that merely *look* strong. A `null` estimate — the
 * estimator failed, or has not settled yet — is not treated as a pass.
 */
export function canCreateVault(draft: MasterPasswordDraft): boolean {
  return masterPasswordBlocker(draft) === null;
}

export interface MasterPasswordDraft {
  readonly secret: string;
  readonly confirmSecret: string;
  readonly acknowledged: boolean;
  readonly strength: PasswordStrength | null;
  readonly busy: boolean;
}

/**
 * Why the create button is unavailable, in the user's words — or `null` when it is available.
 *
 * A disabled control with no explanation is a dead end: the user can see that something is
 * wrong and has no way to find out what. Returning the reason means the screen can say it
 * out loud, which is also what makes the requirement testable as a sentence rather than as
 * a boolean somebody has to interpret.
 *
 * Order matters — it reports the thing the user should fix *first*, not the last condition
 * that happened to fail.
 */
export function masterPasswordBlocker(draft: MasterPasswordDraft): string | null {
  if (draft.busy) return 'Creating your vault…';
  if (draft.secret === '') return 'Choose a master password to continue.';
  if (draft.strength === null) return 'Checking how strong that password is…';
  if (!draft.strength.meetsMasterMinimum) {
    return 'Keyhold needs a longer, less predictable master password before it will create a vault.';
  }
  if (draft.confirmSecret === '') return 'Type the password a second time to confirm it.';
  if (draft.secret !== draft.confirmSecret) return 'The two passwords do not match.';
  if (!draft.acknowledged) {
    return 'Tick the box above to confirm you understand there is no way to reset this password.';
  }
  return null;
}

/**
 * Whether the flow may move on from a step under its own steam.
 *
 * Distinct from skipping. Skipping *dismisses* the whole flow and is always allowed (see
 * {@link onboardingReducer}); this is about the ordinary forward path, where a step that
 * has not done its job must not silently pass.
 */
export function canAdvanceFrom(state: OnboardingState, stepId = state.stepId): boolean {
  switch (stepId) {
    case 'welcome':
      return true;
    // Nothing past this step makes sense without a vault, and a vault cannot exist without
    // the acknowledgement — so the gate is restated here rather than assumed.
    case 'master-password':
      return state.vaultCreated && state.acknowledgedNoRecovery;
    case 'vault-file':
      return state.vaultCreated;
    case 'first-credential':
      return true;
    case 'what-next':
      return canFinishOnboarding(state);
  }
}

/**
 * Whether the flow may be marked completed.
 *
 * Deliberately re-checks the acknowledgement rather than trusting that the master-password
 * step already did. Resumed state comes from `localStorage`, which is editable, and a flow
 * that could be *completed* without an acknowledgement would mean a vault existed that
 * nobody was ever told they could not recover. Two independent checks, because there is no
 * version of this being wrong that is cheap.
 */
export function canFinishOnboarding(state: OnboardingState): boolean {
  return state.vaultCreated && state.acknowledgedNoRecovery;
}

/**
 * Whether there is a meaningful step to go back to.
 *
 * Back stops at the master-password step once a vault exists. That step's form cannot do
 * anything for a vault that already has a password, so offering to return to it would be
 * offering a screen with no working control on it — the kind of dead end that makes people
 * think they have broken something.
 */
export function canGoBackFrom(state: OnboardingState): boolean {
  const previous = previousStepId(state.stepId);
  if (previous === null) return false;
  if (state.vaultCreated && stepIndex(previous) <= stepIndex('master-password')) return false;
  return true;
}

export function onboardingReducer(
  state: OnboardingState,
  action: OnboardingAction
): OnboardingState {
  // A finished flow is finished. Late actions — an in-flight promise resolving after the
  // user skipped — must not reopen it.
  if (state.outcome !== 'active' && action.type !== 'dismiss' && action.type !== 'complete') {
    return state;
  }

  switch (action.type) {
    case 'acknowledge':
      return state.acknowledgedNoRecovery === action.value
        ? state
        : { ...state, acknowledgedNoRecovery: action.value };

    case 'vault-created':
      return state.vaultCreated ? state : { ...state, vaultCreated: true };

    case 'first-credential-saved':
      return state.firstCredentialSaved ? state : { ...state, firstCredentialSaved: true };

    case 'advance': {
      if (!canAdvanceFrom(state)) return state;
      if (isLastStep(state.stepId)) return state;
      const next = nextStepId(state.stepId);
      return next === null ? state : { ...state, stepId: next };
    }

    case 'back': {
      if (!canGoBackFrom(state)) return state;
      const previous = previousStepId(state.stepId);
      return previous === null ? state : { ...state, stepId: previous };
    }

    case 'complete':
      if (!canFinishOnboarding(state)) return state;
      return state.outcome === 'completed' ? state : { ...state, outcome: 'completed' };

    // Always available, from every step, with no conditions and no confirmation. Skipping
    // is not the same as completing: it leaves the flow behind without ever claiming the
    // user was told anything, and it creates nothing. Someone who skips at step one lands
    // back on the ordinary create screen, which carries its own acknowledgement.
    case 'dismiss':
      return state.outcome === 'dismissed' ? state : { ...state, outcome: 'dismissed' };
  }
}

/**
 * Pulls a resumed state back onto a step it is actually allowed to be on.
 *
 * Stored progress is validated on the way in, but validation only proves the shape is
 * right. This proves the *position* is right: a record pointing at "what next" with no
 * vault created would otherwise render a summary of a setup that never happened.
 */
export function reconcileResumedState(state: OnboardingState): OnboardingState {
  const stepId = canonicalStepFor(state.stepId, state.vaultCreated);
  return stepId === state.stepId ? state : { ...state, stepId };
}
