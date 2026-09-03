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

/**
 * Whether a step is one of the ones that exist to *get* you a vault.
 *
 * **Not a second list** (hard rule 8): the boundary is `canonicalStepFor`'s own, read back
 * out of it. That function clamps a vault-less flow to the last step it may legitimately sit
 * on, so a step it leaves alone when `vaultCreated` is false is — by definition — a step
 * that comes before the vault. Move the boundary in `onboarding-steps.ts` and this moves
 * with it, with nothing here to find and update.
 */
function isPreVaultStep(stepId: OnboardingStepId): boolean {
  return canonicalStepFor(stepId, false) === stepId;
}

/**
 * A step with nothing left to say: it is about acquiring a vault, and one already exists.
 *
 * The master-password step is the reason this exists. Its only control creates the vault, so
 * putting it in front of somebody who has one is at best a dead form and at worst an
 * invitation to point `onCreateVault` at a file full of passwords. {@link canGoBackFrom}
 * already refuses to walk *backwards* onto it; this is the same rule applied to the other two
 * ways of arriving there — resuming a record that points at it, and re-running the tour.
 */
function isSpentStep(stepId: OnboardingStepId, vaultCreated: boolean): boolean {
  return vaultCreated && isPreVaultStep(stepId);
}

/**
 * Walks forward off any spent step. `null` only if the walk runs off the end of the list.
 *
 * A loop rather than a single hop, so a second pre-vault step added later is stepped over
 * too — the failure of a one-hop version would be a create form rendered to somebody who
 * already has a vault, which is precisely the thing being prevented.
 */
function firstLiveStepFrom(
  stepId: OnboardingStepId | null,
  vaultCreated: boolean
): OnboardingStepId | null {
  let candidate = stepId;
  while (candidate !== null && isSpentStep(candidate, vaultCreated)) {
    candidate = nextStepId(candidate);
  }
  return candidate;
}

export function onboardingReducer(
  state: OnboardingState,
  action: OnboardingAction
): OnboardingState {
  /*
   * A finished flow is finished, and that includes the two actions that finish it.
   *
   * `dismiss` and `complete` used to be exempt from this guard, which meant Escape or a
   * stray click landing after the last step turned a *completed* flow into a *dismissed*
   * one — and dismissed is the outcome that claims the user was never told anything. The
   * persisted record would then disagree with what actually happened. An outcome is
   * terminal; there is no action that may overwrite one with another.
   */
  if (state.outcome !== 'active') return state;

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
      // Not `nextStepId` directly: the step after this one may be spent — a re-run of the
      // tour starts with a vault already in hand, so the create-vault step must be walked
      // over rather than landed on.
      const next = firstLiveStepFrom(nextStepId(state.stepId), state.vaultCreated);
      return next === null ? state : { ...state, stepId: next };
    }

    case 'back': {
      if (!canGoBackFrom(state)) return state;
      const previous = previousStepId(state.stepId);
      return previous === null ? state : { ...state, stepId: previous };
    }

    case 'complete':
      if (!canFinishOnboarding(state)) return state;
      return { ...state, outcome: 'completed' };

    // Always available, from every step, with no conditions and no confirmation — by the
    // skip control, and by Escape, which is the same decision taken with the keyboard.
    // Skipping is not the same as completing: it leaves the flow behind without ever
    // claiming the user was told anything, and it creates nothing. Someone who skips at
    // step one lands back on the ordinary create screen, which carries its own
    // acknowledgement.
    case 'dismiss':
      return { ...state, outcome: 'dismissed' };
  }
}

/**
 * Pulls a resumed state back onto a step it is actually allowed to be on.
 *
 * Stored progress is validated on the way in, but validation only proves the shape is
 * right. This proves the *position* is right, and it is wrong in both directions:
 *
 * - **Too far forward.** A record pointing at "what next" with no vault created would
 *   render a summary of a setup that never happened. {@link canonicalStepFor} clamps it back.
 * - **Not far enough.** A record pointing at the master-password step *with* a vault
 *   created would render the create form to somebody whose vault already exists. This is
 *   not hypothetical: progress is written on every state change, so `vault-created` is
 *   persisted at that step a moment before `advance` moves off it, and a crash, a kill or a
 *   power cut in that window leaves exactly this record behind. {@link firstLiveStepFrom}
 *   walks it forward to the first step that describes the vault they now have.
 */
export function reconcileResumedState(state: OnboardingState): OnboardingState {
  const clamped = canonicalStepFor(state.stepId, state.vaultCreated);
  const stepId = firstLiveStepFrom(clamped, state.vaultCreated) ?? clamped;
  return stepId === state.stepId ? state : { ...state, stepId };
}

// ── Running the tour a second time ───────────────────────────────────────────

/**
 * Which run of the flow this is.
 *
 * The roadmap asks for a tour that is *skippable and re-runnable*, and the two halves need
 * different behaviour from the same component rather than a second component: a first run
 * resumes, persists, and begins by creating a vault; a re-run does none of those things.
 * Expressing it as one prop keeps a single flow, a single reducer and a single set of gates
 * — the alternative is a copy of all three that drifts.
 *
 * It is deliberately **not** part of {@link OnboardingState}: the mode belongs to the mount,
 * not to the progress, and `onboarding-storage.ts` must never be able to write it down.
 */
export type OnboardingMode = 'first-run' | 'revisit';

/**
 * Where a re-run begins: the first step that describes a vault you already have.
 *
 * Derived, not written down. The steps before it are the ones {@link isPreVaultStep}
 * identifies from `canonicalStepFor`'s own boundary, so nothing here names a step id and
 * inserting a step changes this automatically.
 *
 * A re-run therefore skips the welcome screen. That is the honest reading rather than a
 * shortcut: that screen's copy is written for somebody deciding whether to commit ("Setting
 * it up takes about a minute", "The next step covers it properly") and every sentence of it
 * is false for a returning user. The step indicator agrees — it shows the two steps behind
 * this one as already done, which for a person with a vault they created is exactly true.
 */
export const REVISIT_START_STEP_ID: OnboardingStepId =
  firstLiveStepFrom(FIRST_STEP_ID, true) ?? FIRST_STEP_ID;

/**
 * The state a re-run starts from.
 *
 * The two `true`s are **facts about the world, not claims about this run.** A vault exists —
 * that is the precondition for offering a re-run at all — and no vault can exist without the
 * no-recovery acknowledgement having been given first, on this flow's own master-password
 * step or on the ordinary create screen, which carries the same one. Setting them is what
 * makes {@link canGoBackFrom} and {@link canAdvanceFrom} refuse to walk a returning user onto
 * the create form, and what lets the last step's Finish button work at all.
 *
 * **Nothing about a re-run is ever written down.** `OnboardingFlow` persists only in
 * first-run mode, so this state cannot reach `localStorage` and cannot forge a record
 * claiming a setup was completed. That is the property that makes the two `true`s safe, and
 * it is asserted in `OnboardingFlow.test.tsx` rather than left as a comment.
 */
export const REVISIT_ONBOARDING_STATE: OnboardingState = {
  stepId: REVISIT_START_STEP_ID,
  acknowledgedNoRecovery: true,
  vaultCreated: true,
  firstCredentialSaved: false,
  outcome: 'active',
};

/**
 * The state a mount of the flow begins in, as a pure function of the mode and what storage
 * had to offer.
 *
 * A re-run **ignores the stored record entirely** rather than resuming it. Resuming would
 * mean "run the tour again" landing on the summary screen for anyone who finished it once —
 * the flow would open, say "your vault is set up", and offer a Finish button, which is not a
 * tour. A re-run is always the whole of the re-run.
 */
export function initialStateFor(mode: OnboardingMode, resumed: OnboardingState): OnboardingState {
  return mode === 'revisit' ? REVISIT_ONBOARDING_STATE : reconcileResumedState(resumed);
}
