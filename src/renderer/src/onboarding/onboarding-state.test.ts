// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { PasswordStrength } from '@shared/model/strength.js';
import {
  canAdvanceFrom,
  canCreateVault,
  canFinishOnboarding,
  canGoBackFrom,
  initialStateFor,
  INITIAL_ONBOARDING_STATE,
  masterPasswordBlocker,
  onboardingReducer,
  reconcileResumedState,
  REVISIT_ONBOARDING_STATE,
  REVISIT_START_STEP_ID,
  type MasterPasswordDraft,
  type OnboardingState,
} from './onboarding-state.js';
import {
  canonicalStepFor,
  isKnownStepId,
  nextStepId,
  ONBOARDING_STEPS,
  previousStepId,
  stepIndex,
} from './onboarding-steps.js';

/**
 * The step machine and its gates.
 *
 * `@testing-library/react` is not a dependency of this project (checked: it is not in
 * `package.json`, and it is not being added for this), so the flow's *rendering* is covered
 * only by the small `react-dom` harness in `OnboardingFlow.test.tsx`. Everything with a
 * consequence lives here instead, as pure functions, where it can be pinned down properly.
 *
 * The single most important assertion in this file is that **an unacknowledged flow cannot
 * be completed and cannot create a vault** — from either direction, including through a
 * resumed state that claims otherwise.
 */

function strength(overrides: Partial<PasswordStrength> = {}): PasswordStrength {
  return {
    score: 4,
    label: 'Very strong',
    guesses: 1e14,
    crackTime: 'thousands of years',
    warning: null,
    suggestions: [],
    meetsMasterMinimum: true,
    ...overrides,
  };
}

function draft(overrides: Partial<MasterPasswordDraft> = {}): MasterPasswordDraft {
  return {
    secret: 'copper-lantern-drift-oyster',
    confirmSecret: 'copper-lantern-drift-oyster',
    acknowledged: true,
    strength: strength(),
    busy: false,
    ...overrides,
  };
}

function state(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return { ...INITIAL_ONBOARDING_STATE, ...overrides };
}

describe('the step list', () => {
  it('has no duplicate ids — the index lookup depends on it', () => {
    const ids = ONBOARDING_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('walks forward and back over the same order', () => {
    for (let index = 0; index < ONBOARDING_STEPS.length; index += 1) {
      const step = ONBOARDING_STEPS[index]!;
      expect(stepIndex(step.id)).toBe(index);
      expect(nextStepId(step.id)).toBe(ONBOARDING_STEPS[index + 1]?.id ?? null);
      expect(previousStepId(step.id)).toBe(index === 0 ? null : ONBOARDING_STEPS[index - 1]!.id);
    }
  });

  it('rejects anything that is not a step id', () => {
    for (const value of [null, undefined, 42, {}, [], '', 'welcome ', 'WELCOME', '__proto__']) {
      expect(isKnownStepId(value)).toBe(false);
    }
    expect(isKnownStepId('welcome')).toBe(true);
  });

  it('clamps a resumed step to one that can actually be shown', () => {
    // No vault yet, but the record claims the summary screen. Rendering "here is your
    // vault" for a vault that does not exist is worse than repeating a step.
    expect(canonicalStepFor('what-next', false)).toBe('master-password');
    expect(canonicalStepFor('vault-file', false)).toBe('master-password');
    expect(canonicalStepFor('welcome', false)).toBe('welcome');
    expect(canonicalStepFor('what-next', true)).toBe('what-next');
  });
});

describe('the acknowledgement gate', () => {
  it('refuses to create a vault without the acknowledgement', () => {
    expect(canCreateVault(draft({ acknowledged: false }))).toBe(false);
    expect(masterPasswordBlocker(draft({ acknowledged: false }))).toContain('Tick the box');
  });

  it('refuses to finish onboarding without the acknowledgement', () => {
    const unacknowledged = state({ vaultCreated: true, acknowledgedNoRecovery: false });
    expect(canFinishOnboarding(unacknowledged)).toBe(false);

    const after = onboardingReducer(
      { ...unacknowledged, stepId: 'what-next' },
      { type: 'complete' }
    );
    expect(after.outcome).toBe('active');
  });

  it('refuses to advance past the master-password step without it', () => {
    // Even with the vault somehow created, the flow does not move on unacknowledged.
    const smuggled = state({ stepId: 'master-password', vaultCreated: true });
    expect(canAdvanceFrom(smuggled)).toBe(false);
    expect(onboardingReducer(smuggled, { type: 'advance' }).stepId).toBe('master-password');
  });

  it('lets a fully acknowledged flow through', () => {
    const ready = state({
      stepId: 'master-password',
      vaultCreated: true,
      acknowledgedNoRecovery: true,
    });
    expect(canAdvanceFrom(ready)).toBe(true);
    expect(onboardingReducer(ready, { type: 'advance' }).stepId).toBe('vault-file');
    expect(canFinishOnboarding(ready)).toBe(true);
  });
});

describe('the create-vault predicate', () => {
  it('accepts a strong, confirmed, acknowledged password', () => {
    expect(canCreateVault(draft())).toBe(true);
    expect(masterPasswordBlocker(draft())).toBeNull();
  });

  it('never treats a missing estimate as a pass', () => {
    // The estimator failed or has not settled. "We could not check" is not "it is fine".
    expect(canCreateVault(draft({ strength: null }))).toBe(false);
  });

  it('defers entirely to the estimator for strength', () => {
    // A long, complicated-looking password that the main process rejects. Nothing here
    // gets to overrule that — a second, weaker local definition of "strong" is the exact
    // failure `src/main/session/strength.ts` exists to prevent.
    const looksFine = draft({
      secret: 'P@ssw0rd123!!',
      confirmSecret: 'P@ssw0rd123!!',
      strength: strength({ score: 3, label: 'Strong', meetsMasterMinimum: false }),
    });
    expect(canCreateVault(looksFine)).toBe(false);
    expect(masterPasswordBlocker(looksFine)).toContain('longer, less predictable');
  });

  it('reports the first thing to fix, not the last thing that failed', () => {
    const nothingTyped = draft({ secret: '', confirmSecret: '', acknowledged: false });
    expect(masterPasswordBlocker(nothingTyped)).toBe('Choose a master password to continue.');
  });

  it('catches a mismatch and a busy submit', () => {
    expect(canCreateVault(draft({ confirmSecret: 'something else' }))).toBe(false);
    expect(canCreateVault(draft({ busy: true }))).toBe(false);
  });
});

describe('skipping', () => {
  it('is available from every step, with no conditions', () => {
    for (const step of ONBOARDING_STEPS) {
      const dismissed = onboardingReducer(state({ stepId: step.id }), { type: 'dismiss' });
      expect(dismissed.outcome).toBe('dismissed');
    }
  });

  it('is not the same as completing — it never claims the user was told anything', () => {
    const dismissed = onboardingReducer(state(), { type: 'dismiss' });
    expect(dismissed.outcome).toBe('dismissed');
    expect(dismissed.acknowledgedNoRecovery).toBe(false);
    expect(dismissed.vaultCreated).toBe(false);
  });

  it('cannot be reopened by a late action', () => {
    // The user skipped while a create was in flight. Its resolution must not resurrect
    // the flow underneath them.
    const dismissed = onboardingReducer(state(), { type: 'dismiss' });
    expect(onboardingReducer(dismissed, { type: 'vault-created' })).toBe(dismissed);
    expect(onboardingReducer(dismissed, { type: 'advance' })).toBe(dismissed);
  });

  it('cannot overwrite an outcome that has already been reached', () => {
    /*
     * Escape and the skip control both dispatch `dismiss`, and Escape is a key somebody can
     * still be holding as the last step finishes. Letting it land on a *completed* flow
     * would rewrite the record as "dismissed" — the outcome that says the user was never
     * told anything — for a user who was told everything. An outcome is terminal in both
     * directions.
     */
    const finished = onboardingReducer(
      state({ stepId: 'what-next', vaultCreated: true, acknowledgedNoRecovery: true }),
      { type: 'complete' }
    );
    expect(finished.outcome).toBe('completed');
    expect(onboardingReducer(finished, { type: 'dismiss' })).toBe(finished);

    const skippedAtTheEnd = onboardingReducer(
      state({ stepId: 'what-next', vaultCreated: true, acknowledgedNoRecovery: true }),
      { type: 'dismiss' }
    );
    expect(skippedAtTheEnd.outcome).toBe('dismissed');
    expect(onboardingReducer(skippedAtTheEnd, { type: 'complete' })).toBe(skippedAtTheEnd);
  });
});

describe('moving between steps', () => {
  it('does not run off the end', () => {
    const last = state({
      stepId: 'what-next',
      vaultCreated: true,
      acknowledgedNoRecovery: true,
    });
    expect(onboardingReducer(last, { type: 'advance' }).stepId).toBe('what-next');
  });

  it('stops going back at the master-password step once a vault exists', () => {
    const afterCreate = state({
      stepId: 'vault-file',
      vaultCreated: true,
      acknowledgedNoRecovery: true,
    });
    expect(canGoBackFrom(afterCreate)).toBe(false);
    expect(onboardingReducer(afterCreate, { type: 'back' }).stepId).toBe('vault-file');

    const later = { ...afterCreate, stepId: 'what-next' } as const;
    expect(canGoBackFrom(later)).toBe(true);
    expect(onboardingReducer(later, { type: 'back' }).stepId).toBe('first-credential');
  });

  it('goes back freely before a vault exists', () => {
    const onPassword = state({ stepId: 'master-password' });
    expect(onboardingReducer(onPassword, { type: 'back' }).stepId).toBe('welcome');
    expect(canGoBackFrom(state({ stepId: 'welcome' }))).toBe(false);
  });

  it('treats the optional credential step as passable either way', () => {
    const here = state({
      stepId: 'first-credential',
      vaultCreated: true,
      acknowledgedNoRecovery: true,
    });
    expect(canAdvanceFrom(here)).toBe(true);
    expect(onboardingReducer(here, { type: 'advance' }).stepId).toBe('what-next');
  });
});

describe('resumption', () => {
  it('pulls an impossible position back onto a possible one', () => {
    const impossible = state({ stepId: 'what-next', vaultCreated: false });
    expect(reconcileResumedState(impossible).stepId).toBe('master-password');
  });

  it('leaves a consistent state exactly as it was', () => {
    const fine = state({
      stepId: 'first-credential',
      vaultCreated: true,
      acknowledgedNoRecovery: true,
    });
    expect(reconcileResumedState(fine)).toBe(fine);
  });

  it('pulls a record left mid-creation forward, off the create form', () => {
    /*
     * The window this closes is real and about a second wide. Progress is written on every
     * state change, so `vault-created` is persisted while the flow is still *on* the
     * master-password step, a tick before `advance` moves it off. A crash, a kill or a power
     * cut in that gap leaves exactly this record — and resuming it used to render "Choose
     * your master password", with a working Create button, to somebody whose vault already
     * existed and already held whatever they had put in it.
     */
    const midCreation = state({
      stepId: 'master-password',
      vaultCreated: true,
      acknowledgedNoRecovery: true,
    });
    expect(reconcileResumedState(midCreation).stepId).toBe(REVISIT_START_STEP_ID);
  });
});

// ── Running the tour a second time ───────────────────────────────────────────

describe('a re-run of the tour', () => {
  it('starts at the first step that describes a vault you already have', () => {
    /*
     * Asserted against `canonicalStepFor`'s own boundary rather than against the literal
     * 'vault-file', so this cannot quietly go on agreeing with a stale answer after a step
     * is inserted. The step immediately before a re-run's start must be the last step a
     * vault-less flow is allowed to sit on — that is what "past the screens that get you a
     * vault, and no further" means, written as an equation rather than as a name.
     */
    const lastPreVaultStep = canonicalStepFor(ONBOARDING_STEPS.at(-1)!.id, false);
    expect(previousStepId(REVISIT_START_STEP_ID)).toBe(lastPreVaultStep);
    expect(canonicalStepFor(REVISIT_START_STEP_ID, false)).not.toBe(REVISIT_START_STEP_ID);
  });

  it('steps over the create-vault screen instead of landing on it', () => {
    // The only way to be on the welcome screen with a vault already made is a hand-edited
    // record — but "then show them the create form" is not an acceptable answer to one.
    const odd = state({ stepId: 'welcome', vaultCreated: true, acknowledgedNoRecovery: true });
    expect(onboardingReducer(odd, { type: 'advance' }).stepId).toBe(REVISIT_START_STEP_ID);
  });

  it('can never reach the step that creates a vault, forwards or backwards', () => {
    // The guarantee, walked rather than reasoned about: drive the whole flow from where a
    // re-run begins, trying to go back at every stop, and prove the create form is not on
    // the graph at all.
    const visited: string[] = [REVISIT_ONBOARDING_STATE.stepId];
    let current = REVISIT_ONBOARDING_STATE;

    for (let guard = 0; guard < ONBOARDING_STEPS.length * 2; guard += 1) {
      visited.push(onboardingReducer(current, { type: 'back' }).stepId);
      const advanced = onboardingReducer(current, { type: 'advance' });
      if (advanced === current) break;
      current = advanced;
      visited.push(current.stepId);
    }

    expect(visited).not.toContain('master-password');
    // And it did actually get to the end, rather than stalling on step one and passing.
    expect(current.stepId).toBe(ONBOARDING_STEPS.at(-1)!.id);
  });

  it('can be finished, and closed, from the state it starts in', () => {
    /*
     * This is what the two `true`s in `REVISIT_ONBOARDING_STATE` buy, and the reason they
     * are not a lie: a vault exists, and no vault can exist without the acknowledgement
     * having been given. Drop either and the flow becomes a screen with a Finish button that
     * silently does nothing — `canFinishOnboarding` re-checks both.
     */
    expect(REVISIT_ONBOARDING_STATE.outcome).toBe('active');
    expect(canFinishOnboarding(REVISIT_ONBOARDING_STATE)).toBe(true);
    expect(onboardingReducer(REVISIT_ONBOARDING_STATE, { type: 'dismiss' }).outcome).toBe(
      'dismissed'
    );

    const atTheEnd = { ...REVISIT_ONBOARDING_STATE, stepId: ONBOARDING_STEPS.at(-1)!.id };
    expect(onboardingReducer(atTheEnd, { type: 'complete' }).outcome).toBe('completed');
  });
});

describe('the state a mount starts in', () => {
  it('resumes stored progress on a first run', () => {
    const stored = state({
      stepId: 'first-credential',
      vaultCreated: true,
      acknowledgedNoRecovery: true,
    });
    expect(initialStateFor('first-run', stored)).toBe(stored);
  });

  it('still reconciles an impossible stored position on a first run', () => {
    expect(initialStateFor('first-run', state({ stepId: 'what-next' })).stepId).toBe(
      'master-password'
    );
  });

  it('ignores stored progress entirely on a re-run', () => {
    // Including — especially — a record saying the tour was finished. Resuming that would
    // make "run the tour again" open on the summary screen with a Finish button, which is
    // not a tour; and it is the state every user who ran the tour once is in.
    const finished = state({
      stepId: 'what-next',
      vaultCreated: true,
      acknowledgedNoRecovery: true,
      outcome: 'completed',
    });
    expect(initialStateFor('revisit', finished)).toBe(REVISIT_ONBOARDING_STATE);
    expect(initialStateFor('revisit', INITIAL_ONBOARDING_STATE)).toBe(REVISIT_ONBOARDING_STATE);
  });
});

// ── The estimator is the only definition of "strong enough" ──────────────────

/**
 * Every source file in this directory, as text.
 *
 * `import.meta.glob` rather than `node:fs`: the renderer has no Node access by design and
 * the lint config enforces that, so a test that reached for `readFile` would be teaching
 * the wrong shape even though it only ever runs under Vitest. Vite reads these at transform
 * time, which also means a file added later is picked up without anyone listing it.
 */
const ONBOARDING_SOURCES = import.meta.glob<string>('./*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('there is no second strength meter', () => {
  /**
   * The structural half of `defers entirely to the estimator for strength`.
   *
   * That test proves the *reducer* asks the estimator. This proves nothing else in the flow
   * quietly answers the question itself — because a hand-rolled length-and-character-class
   * meter is not a simpler version of `src/main/session/strength.ts`, it is a different and
   * wrong answer, and the one it is wrong about is `P@ssw0rd1!`. The floor lives in the main
   * process (`MINIMUM_MASTER_SCORE`, `MINIMUM_MASTER_LENGTH`); the renderer is handed a
   * verdict and never a threshold.
   *
   * Modelled on the guard in `keeptheme-format.test.ts` that keeps the WCAG maths in one
   * place, for the same reason: two implementations of one rule drift, and the weaker one is
   * the one that ends up in front of the user.
   */
  it('nothing in the flow re-derives a verdict from a password', () => {
    const sources = Object.entries(ONBOARDING_SOURCES).filter(([name]) => !name.includes('.test.'));
    expect(sources.length).toBeGreaterThan(0);

    for (const [name, source] of sources) {
      // A length threshold applied to anything holding a password. `suggestions.length > 0`
      // is an array length and is deliberately not matched.
      expect(
        /\b\w*(?:secret|password|passphrase)\w*\.length\s*[<>]=?/i.test(source),
        `${name} measures a password's length itself`
      ).toBe(false);

      // Producing a verdict, rather than reading the one the estimator produced.
      expect(
        /meetsMasterMinimum\s*[:=][^=]/.test(source),
        `${name} decides "strong enough" for itself`
      ).toBe(false);

      // The floor's own constants. They live in the main process and are not importable
      // here, so finding either name would mean somebody had copied the number across.
      for (const constant of ['MINIMUM_MASTER_SCORE', 'MINIMUM_MASTER_LENGTH']) {
        expect(source.includes(constant), `${name} restates ${constant}`).toBe(false);
      }
    }
  });
});
