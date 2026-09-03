// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useReducer, useRef } from 'react';
import type { PasswordStrength } from '@shared/model/strength.js';
import { Button } from '../components/Button.js';
import { FirstCredentialStep } from './FirstCredentialStep.js';
import { MasterPasswordStep } from './MasterPasswordStep.js';
import { StepIndicator } from './StepIndicator.js';
import { VaultFileStep } from './VaultFileStep.js';
import { WelcomeStep } from './WelcomeStep.js';
import { WhatNextStep } from './WhatNextStep.js';
import {
  canGoBackFrom,
  initialStateFor,
  onboardingReducer,
  type FirstCredentialDraft,
  type OnboardingMode,
  type OnboardingState,
} from './onboarding-state.js';
import { stepById } from './onboarding-steps.js';
import { moveProgress, readProgress, writeProgress } from './onboarding-storage.js';
import './onboarding.css';

/**
 * The first-run flow.
 *
 * ## What it is responsible for
 *
 * Sequencing, focus, persistence, and the gates. Nothing else. It owns no vault, opens no
 * dialog, writes no credential and navigates nowhere — **every side effect is a callback
 * the host passes in**, so the same flow can be mounted from the app root today and from a
 * "run the tour again" command later without either of them being a special case.
 *
 * ## Focus
 *
 * Focus moves to the step's heading on every transition, including the first render. That
 * is why no field inside a step carries `autoFocus`: two things calling `focus()` in one
 * commit is a race, and a heading that is skipped means a screen-reader user is dropped
 * into a text field with no idea what screen they are on. The heading is `tabIndex={-1}`
 * so it can receive programmatic focus without becoming a tab stop of its own; Tab from
 * there lands on the first control of the step.
 *
 * ## Resumption
 *
 * Progress is read once, lazily, when the reducer initialises, and written on every change.
 * A missing, unreadable, corrupt, stale or self-contradictory record all mean the same
 * thing — start at the beginning. See `onboarding-storage.ts`, which also carries the rule
 * that **nothing the user typed is ever written there.**
 *
 * ## Running it a second time
 *
 * `mode` is the whole of it. `first-run` is the flow described above; `revisit` is the same
 * five steps re-read on demand by somebody who already has a vault, and it differs in
 * exactly three ways, all of them here rather than spread through the steps:
 *
 * 1. **It starts at `REVISIT_START_STEP_ID`**, past the screens that exist to get you
 *    a vault, and the reducer's own gates make the create form unreachable from there.
 * 2. **It never writes.** Not the progress, not the re-scope. A re-run that persisted would
 *    overwrite a `completed` record with the `dismissed` that closing it produces — turning
 *    a user who was told everything into one the record says was told nothing.
 * 3. **It says so.** The kicker and the leave control name what is actually happening; there
 *    is no setup here to skip.
 *
 * Nothing else changes, which is the point: one flow, one reducer, one set of gates. The
 * host decides *when* to mount it — see `onboarding-visibility.ts` for the first-run
 * question; a re-run is an explicit user action and has no condition to compute.
 *
 * ## Skipping
 *
 * The skip control is rendered by this component rather than by the steps, so it is in the
 * same place on every screen and cannot be forgotten by a step added later. It asks no
 * confirmation question and carries no guilt copy. Skipping is not completing: it marks the
 * flow dismissed without ever claiming the user was told anything, and it creates nothing —
 * someone who skips on step one lands on the ordinary create screen, which carries the same
 * no-recovery acknowledgement.
 *
 * **Escape does the same thing as the skip button**, because a full-screen surface that
 * swallows Escape is how a first-run flow becomes a trap. The two paths share one action, so
 * they cannot come to mean different things.
 */

export interface OnboardingFlowProps {
  /**
   * Which run this is. Defaults to `'first-run'`, so every existing mount site keeps the
   * behaviour it already had and a re-run has to be asked for on purpose.
   *
   * `'revisit'` is only meaningful with a vault open — three of the five steps describe one.
   * The host is what knows that; see the module comment.
   */
  readonly mode?: OnboardingMode;
  /**
   * Scopes the stored progress. The vault id once one exists, `null` before that — the flow
   * re-keys itself when it changes, so a half-finished tour cannot be inherited by the next
   * vault someone creates.
   *
   * Unused in `'revisit'` mode, which reads and writes nothing.
   */
  readonly vaultKey: string | null;
  /** Where the vault file is, or will be. Shown, never chosen here. */
  readonly vaultPath: string | null;
  /** The main process's estimator, over IPC. `null` means it failed — never a pass. */
  readonly estimateStrength: (secret: string) => Promise<PasswordStrength | null>;
  readonly onCreateVault: (secret: string) => Promise<boolean>;
  readonly onCreateFirstCredential?: (draft: FirstCredentialDraft) => Promise<boolean>;
  readonly onRevealInFolder?: () => void;
  readonly onOpenGenerator?: () => void;
  readonly onImport?: () => void;
  readonly onEnableQuickUnlock?: () => void;
  readonly onOpenAutoLockSettings?: () => void;
  readonly quickUnlockName?: string;
  readonly busy: boolean;
  readonly error: string | null;
  /** Fired once, when the flow finishes or is skipped. */
  readonly onExit: (outcome: 'completed' | 'dismissed') => void;
}

export function OnboardingFlow({
  mode = 'first-run',
  vaultKey,
  vaultPath,
  estimateStrength,
  onCreateVault,
  onCreateFirstCredential,
  onRevealInFolder,
  onOpenGenerator,
  onImport,
  onEnableQuickUnlock,
  onOpenAutoLockSettings,
  quickUnlockName,
  busy,
  error,
  onExit,
}: OnboardingFlowProps): React.JSX.Element {
  // Lazy, and taken from the mode rather than from storage alone: a re-run ignores the
  // stored record entirely. `initialStateFor` is where that choice lives, so it is one pure
  // function a test can hold still rather than a branch buried in an initialiser.
  const [state, dispatch] = useReducer(onboardingReducer, mode, (initialMode) =>
    initialStateFor(initialMode, readProgress(vaultKey))
  );

  const firstRun = mode === 'first-run';

  const headingRef = useRef<HTMLHeadingElement>(null);

  // Declared before the persist effect so a re-key happens first and the write below lands
  // on the new scope rather than leaving the record behind on the old one.
  const scopeRef = useRef(vaultKey);
  useEffect(() => {
    if (scopeRef.current === vaultKey) return;
    if (firstRun) moveProgress(scopeRef.current, vaultKey);
    scopeRef.current = vaultKey;
  }, [firstRun, vaultKey]);

  /*
   * A re-run leaves no trace, and that is a correctness property rather than tidiness.
   *
   * Closing one dispatches `dismiss`, exactly as skipping a first run does. Written down,
   * that would replace a `completed` record with `dismissed` — the outcome whose whole
   * meaning is "this user was never told there is no recovery" — for somebody who walked the
   * entire flow. The record describes the first run and only the first run.
   */
  useEffect(() => {
    if (!firstRun) return;
    writeProgress(vaultKey, state);
  }, [firstRun, vaultKey, state]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [state.stepId]);

  /*
   * Escape leaves the flow, exactly as the skip control does.
   *
   * On the document rather than on the panel: this surface fills the window, and a click on
   * its background leaves focus on `document.body` — outside this component's subtree, so a
   * React `onKeyDown` here would never see the key. Somebody who has clicked the backdrop is
   * precisely the person reaching for Escape.
   *
   * `defaultPrevented` is the guard against a dialog opened over the top. `Modal` prevents
   * and stops Escape so it closes the topmost surface only; this checks the flag as well,
   * because stopping propagation is the caller's discipline and the flag is the record.
   *
   * Gated on `busy` for the same reason the skip button is disabled while busy: the two
   * routes to the same action must not be able to disagree about when it is available.
   */
  useEffect(() => {
    if (busy) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      dispatch({ type: 'dismiss' });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [busy]);

  // Guarded by a ref rather than by unmounting, because the host decides when to unmount
  // and an in-flight promise resolving afterwards must not fire a second exit.
  const exited = useRef(false);
  useEffect(() => {
    if (state.outcome === 'active' || exited.current) return;
    exited.current = true;
    onExit(state.outcome);
  }, [state.outcome, onExit]);

  const step = stepById(state.stepId);

  return (
    <div className="kh-onb">
      <section className="kh-onb__panel" aria-labelledby="kh-onb-heading">
        <header className="kh-onb__header">
          {/* A re-run is not a setup. Saying "Setting up Keyhold" over somebody's existing
              vault is the kind of small lie that makes people wonder what the flow is about
              to do to their data. */}
          <p className="kh-onb__kicker">{firstRun ? 'Setting up Keyhold' : 'The Keyhold tour'}</p>
          {/*
           * `tabIndex={-1}` makes this focusable programmatically without adding a tab stop.
           * Focus lands here on every step change, so the change of screen is announced and
           * the keyboard position is at the top of the new content rather than wherever the
           * previous step's button happened to be.
           */}
          <h1 className="kh-onb__title" id="kh-onb-heading" tabIndex={-1} ref={headingRef}>
            {step?.heading ?? 'Setting up Keyhold'}
          </h1>
        </header>

        <StepIndicator currentStepId={state.stepId} />

        <StepBody
          state={state}
          vaultPath={vaultPath}
          estimateStrength={estimateStrength}
          onCreateVault={onCreateVault}
          {...(onCreateFirstCredential === undefined ? {} : { onCreateFirstCredential })}
          {...(onRevealInFolder === undefined ? {} : { onRevealInFolder })}
          {...(onOpenGenerator === undefined ? {} : { onOpenGenerator })}
          {...(onImport === undefined ? {} : { onImport })}
          {...(onEnableQuickUnlock === undefined ? {} : { onEnableQuickUnlock })}
          {...(onOpenAutoLockSettings === undefined ? {} : { onOpenAutoLockSettings })}
          {...(quickUnlockName === undefined ? {} : { quickUnlockName })}
          busy={busy}
          error={error}
          dispatch={dispatch}
        />

        <footer className="kh-onb__footer">
          {canGoBackFrom(state) && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                dispatch({ type: 'back' });
              }}
            >
              Back
            </Button>
          )}
          <span className="kh-onb__footer-spacer" />
          {/*
            One control, one action, two honest labels. "Skip setup" is exactly right for a
            first run and exactly wrong for a re-run, where there is no setup and nothing is
            being skipped — the vault already exists and closing the tour changes nothing.
            The first-run wording is load-bearing beyond the copy: `src/main/smoke.ts` finds
            this button by matching that text, so it is pinned by a test in
            `OnboardingFlow.test.tsx` rather than left to be discovered by a red CI run.
          */}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              dispatch({ type: 'dismiss' });
            }}
          >
            {firstRun ? 'Skip setup' : 'Close tour'}
          </Button>
        </footer>
      </section>
    </div>
  );
}

interface StepBodyProps {
  readonly state: OnboardingState;
  readonly vaultPath: string | null;
  readonly estimateStrength: (secret: string) => Promise<PasswordStrength | null>;
  readonly onCreateVault: (secret: string) => Promise<boolean>;
  readonly onCreateFirstCredential?: (draft: FirstCredentialDraft) => Promise<boolean>;
  readonly onRevealInFolder?: () => void;
  readonly onOpenGenerator?: () => void;
  readonly onImport?: () => void;
  readonly onEnableQuickUnlock?: () => void;
  readonly onOpenAutoLockSettings?: () => void;
  readonly quickUnlockName?: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly dispatch: React.Dispatch<Parameters<typeof onboardingReducer>[1]>;
}

/**
 * The switch, kept separate so the flow above reads as sequencing rather than as five
 * screens' worth of props threaded through one return statement.
 */
function StepBody(props: StepBodyProps): React.JSX.Element {
  const { state, dispatch } = props;
  const advance = (): void => {
    dispatch({ type: 'advance' });
  };

  switch (state.stepId) {
    case 'welcome':
      return <WelcomeStep onContinue={advance} />;

    case 'master-password':
      return (
        <MasterPasswordStep
          vaultPath={props.vaultPath}
          acknowledged={state.acknowledgedNoRecovery}
          onAcknowledgedChange={(value) => {
            dispatch({ type: 'acknowledge', value });
          }}
          estimateStrength={props.estimateStrength}
          onCreateVault={props.onCreateVault}
          onVaultCreated={() => {
            // Two dispatches, in order: the gate opens, then the flow walks through it.
            // Advancing without recording the creation would be a no-op, which is exactly
            // what `canAdvanceFrom` is for.
            dispatch({ type: 'vault-created' });
            dispatch({ type: 'advance' });
          }}
          {...(props.onOpenGenerator === undefined
            ? {}
            : { onOpenGenerator: props.onOpenGenerator })}
          busy={props.busy}
          error={props.error}
        />
      );

    case 'vault-file':
      return (
        <VaultFileStep
          vaultPath={props.vaultPath}
          {...(props.onRevealInFolder === undefined
            ? {}
            : { onRevealInFolder: props.onRevealInFolder })}
          onContinue={advance}
        />
      );

    case 'first-credential':
      return (
        <FirstCredentialStep
          {...(props.onCreateFirstCredential === undefined
            ? {}
            : { onSave: props.onCreateFirstCredential })}
          onSaved={() => {
            dispatch({ type: 'first-credential-saved' });
            dispatch({ type: 'advance' });
          }}
          onSkip={advance}
          busy={props.busy}
          error={props.error}
        />
      );

    case 'what-next':
      return (
        <WhatNextStep
          {...(props.onImport === undefined ? {} : { onImport: props.onImport })}
          {...(props.onEnableQuickUnlock === undefined
            ? {}
            : { onEnableQuickUnlock: props.onEnableQuickUnlock })}
          {...(props.onOpenAutoLockSettings === undefined
            ? {}
            : { onOpenAutoLockSettings: props.onOpenAutoLockSettings })}
          {...(props.quickUnlockName === undefined
            ? {}
            : { quickUnlockName: props.quickUnlockName })}
          firstCredentialSaved={state.firstCredentialSaved}
          onFinish={() => {
            dispatch({ type: 'complete' });
          }}
        />
      );
  }
}
