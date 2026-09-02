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
  onboardingReducer,
  type FirstCredentialDraft,
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
 * ## Skipping
 *
 * The skip control is rendered by this component rather than by the steps, so it is in the
 * same place on every screen and cannot be forgotten by a step added later. It asks no
 * confirmation question and carries no guilt copy. Skipping is not completing: it marks the
 * flow dismissed without ever claiming the user was told anything, and it creates nothing —
 * someone who skips on step one lands on the ordinary create screen, which carries the same
 * no-recovery acknowledgement.
 */

export interface OnboardingFlowProps {
  /**
   * Scopes the stored progress. The vault id once one exists, `null` before that — the flow
   * re-keys itself when it changes, so a half-finished tour cannot be inherited by the next
   * vault someone creates.
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
  const [state, dispatch] = useReducer(onboardingReducer, vaultKey, readProgress);

  const headingRef = useRef<HTMLHeadingElement>(null);

  // Declared before the persist effect so a re-key happens first and the write below lands
  // on the new scope rather than leaving the record behind on the old one.
  const scopeRef = useRef(vaultKey);
  useEffect(() => {
    if (scopeRef.current === vaultKey) return;
    moveProgress(scopeRef.current, vaultKey);
    scopeRef.current = vaultKey;
  }, [vaultKey]);

  useEffect(() => {
    writeProgress(vaultKey, state);
  }, [vaultKey, state]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [state.stepId]);

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
          <p className="kh-onb__kicker">Setting up Keyhold</p>
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
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              dispatch({ type: 'dismiss' });
            }}
          >
            Skip setup
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
