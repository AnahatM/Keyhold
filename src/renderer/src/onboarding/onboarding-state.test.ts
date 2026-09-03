// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { PasswordStrength } from '@shared/model/strength.js';
import {
  canAdvanceFrom,
  canCreateVault,
  canFinishOnboarding,
  canGoBackFrom,
  INITIAL_ONBOARDING_STATE,
  masterPasswordBlocker,
  onboardingReducer,
  reconcileResumedState,
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
