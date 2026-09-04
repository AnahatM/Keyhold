// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReactNode } from 'react';
import { Button } from '../components/Button.js';
import './onboarding.css';

/**
 * Three things worth doing next — and nothing else.
 *
 * The temptation at the end of a setup flow is to list everything the app can do. That
 * produces a screen nobody acts on. These three are here because each one is a decision the
 * user is better off making now than discovering later: importing is far easier before you
 * have started typing entries by hand, quick unlock changes how often the master password
 * is typed at all, and auto-lock is the single setting that most affects how exposed an
 * unattended machine is.
 *
 * **This step navigates nothing itself.** Every action is a callback the host supplies, and
 * a card whose callback is absent still explains itself and says where the thing lives. A
 * flow that reached into the router would be a flow that could only ever be mounted in one
 * place.
 */

export interface WhatNextStepProps {
  readonly onImport?: () => void;
  readonly onEnableQuickUnlock?: () => void;
  readonly onOpenAutoLockSettings?: () => void;
  /**
   * The platform's own words for quick unlock — "Windows Hello", "Touch ID". Supplied by
   * the host from the session status rather than guessed here, because guessing it wrong
   * names a feature the user does not have.
   */
  readonly quickUnlockName?: string;
  readonly firstCredentialSaved: boolean;
  readonly onFinish: () => void;
}

export function WhatNextStep({
  onImport,
  onEnableQuickUnlock,
  onOpenAutoLockSettings,
  quickUnlockName,
  firstCredentialSaved,
  onFinish,
}: WhatNextStepProps): React.JSX.Element {
  return (
    <div className="kh-onb__body">
      <p className="kh-onb__lead">
        Your vault is set up{firstCredentialSaved ? ' and has its first entry' : ''}. None of these
        is required — they are just the three that are easiest to do now.
      </p>

      <ul className="kh-onb__cards">
        <NextCard
          icon="import"
          title="Bring in your existing passwords"
          body="Keyhold imports from over eighteen managers, including 1Password, Bitwarden, LastPass, KeePass and your browser. Every import runs as a dry run first, so you see exactly what will be added before anything is written."
          action={onImport}
          actionLabel="Import from another manager"
          fallback="You will find this under File → Import whenever you are ready."
        />
        <NextCard
          icon="bolt"
          title="Unlock without typing your password every time"
          body={
            quickUnlockName === undefined
              ? 'Quick unlock lets you reopen the vault with your operating system’s own sign-in instead of retyping the master password. The master password still works, and always will.'
              : `Quick unlock lets you reopen this vault with ${quickUnlockName} instead of retyping the master password. The master password still works, and always will.`
          }
          action={onEnableQuickUnlock}
          actionLabel="Turn on quick unlock"
          fallback="You will find this in Settings, under Security."
        />
        <NextCard
          icon="⏱"
          title="Decide when Keyhold locks itself"
          body="By default the vault locks after a period of inactivity. You can make that shorter, or add locking on sleep, on screen lock, or when the window loses focus — whichever matches how exposed the machine you use is."
          action={onOpenAutoLockSettings}
          actionLabel="Set auto-lock"
          fallback="You will find this in Settings, under Security."
        />
      </ul>

      <div className="kh-onb__actions">
        <Button variant="primary" onClick={onFinish}>
          Take me to my vault
        </Button>
      </div>
    </div>
  );
}

function NextCard({
  icon,
  title,
  body,
  action,
  actionLabel,
  fallback,
}: {
  readonly icon: string;
  readonly title: string;
  readonly body: ReactNode;
  /**
   * Explicitly `| undefined` rather than optional. Under `exactOptionalPropertyTypes` an
   * optional prop cannot be *passed* `undefined`, and every one of these is a host callback
   * that is legitimately absent — so the absence is part of the type rather than something
   * three call sites have to spread around.
   */
  readonly action: (() => void) | undefined;
  readonly actionLabel: string;
  readonly fallback: string;
}): React.JSX.Element {
  return (
    <li className="kh-onb__card">
      <span className="kh-onb__card-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="kh-onb__card-text">
        {/* h2 under the flow's h1 — the heading order is the outline a screen-reader user
            navigates by, and skipping a level breaks it. */}
        <h2 className="kh-onb__card-title">{title}</h2>
        <p className="kh-onb__card-body">{body}</p>
        {action === undefined ? (
          <p className="kh-onb__note">{fallback}</p>
        ) : (
          <Button variant="secondary" size="sm" onClick={action}>
            {actionLabel}
          </Button>
        )}
      </div>
    </li>
  );
}
