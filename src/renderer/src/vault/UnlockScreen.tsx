// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { Button } from '../components/Button.js';
import { Icon } from '../components/Icon.js';
import { Input } from '../components/Input.js';
import { KdfProgressBar } from './KdfProgressBar.js';
import { useSession } from './session-store.js';
import './vault-screens.css';

/**
 * Unlocking a vault.
 *
 * Three things this screen has to get right, none of them obvious:
 *
 * **The wait has to be explained.** Argon2 deliberately takes half a second or more, and on
 * a vault created with high cost settings it can take several. An unexplained pause on a
 * password screen reads as "it did not accept my password" — so the button enters a
 * visible working state and says what is happening.
 *
 * **A lockout has to count down.** "Too many attempts" with no timer leaves someone
 * clicking repeatedly and getting nowhere. The remaining time is shown and ticks.
 *
 * **A lock the user did not ask for has to be explained.** Coming back to a locked screen
 * with no context is alarming; "locked after 10 minutes idle" is not.
 */
export function UnlockScreen(): React.JSX.Element {
  const { status, workingPath, busy, error, unlockVault, tryQuickUnlock, goTo } = useSession();

  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);

  const path = workingPath ?? status?.pendingVault?.path ?? null;
  const pending = status?.pendingVault ?? null;
  const quickUnlock = status?.quickUnlock;

  /*
   * The countdown is DERIVED: an absolute deadline from the main process, minus a ticking
   * clock. Nothing is mirrored into state and decremented.
   *
   * That matters twice over. Mirroring a duration gives two sources of truth that drift the
   * moment a status refresh lands mid-tick; and computing the deadline here would mean
   * calling `Date.now()` during render, which is impure and something React's compiler
   * rightly refuses. Both problems disappear once the deadline itself crosses the bridge.
   */
  const lockedUntil = status?.throttle.lockedUntil ?? 0;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (lockedUntil === 0) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, [lockedUntil]);

  const lockedForMs = lockedUntil === 0 ? 0 : Math.max(0, lockedUntil - now);
  const throttled = lockedForMs > 0;
  const canSubmit = !busy && !throttled && password !== '';

  const submit = (): void => {
    if (!canSubmit) return;
    void unlockVault(password).then((unlocked) => {
      // Cleared on both paths. On success there is no reason to keep it; on failure,
      // retyping is expected anyway and a stale value in a password box invites the user
      // to hit enter again without looking.
      setPassword('');
      if (!unlocked) setReveal(false);
    });
  };

  const lockNote = describeLockReason(status?.lastLockReason ?? null);

  return (
    <div className="kh-screen">
      <form
        className="kh-screen__panel"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <header className="kh-screen__header">
          <Icon name="lock" size="lg" className="kh-screen__mark" />
          <h1 className="kh-screen__title">
            {pending === null ? 'Unlock your vault' : `Unlock ${nameOf(path)}`}
          </h1>
          {path !== null && (
            <p className="kh-screen__subtitle">
              <code className="kh-path">{path}</code>
            </p>
          )}
        </header>

        {lockNote !== null && <p className="kh-screen__note kh-screen__note--info">{lockNote}</p>}

        {pending?.hasOrphanedTemp === true && (
          <p className="kh-screen__warning" role="alert">
            A previous save may not have finished. The last complete version of this vault is intact
            and will open normally — the unfinished file has been kept beside it rather than
            deleted, in case it holds newer changes.
          </p>
        )}

        {error !== null && !throttled && (
          <p className="kh-screen__error" role="alert">
            {error}
          </p>
        )}

        {throttled && (
          <p className="kh-screen__error" role="alert">
            Too many failed attempts. Try again in {Math.ceil(lockedForMs / 1000)} second
            {Math.ceil(lockedForMs / 1000) === 1 ? '' : 's'}.
          </p>
        )}

        <Input
          label="Master password"
          type={reveal ? 'text' : 'password'}
          value={password}
          autoFocus
          autoComplete="current-password"
          secret={reveal}
          disabled={throttled || busy}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          trailing={
            <Button
              variant="ghost"
              size="sm"
              iconOnlyLabel={reveal ? 'Hide the password' : 'Show the password'}
              onClick={() => {
                setReveal(!reveal);
              }}
            >
              <Icon name={reveal ? 'hide' : 'reveal'} size="sm" />
            </Button>
          }
        />

        {/*
          Argon2 is intentionally slow, and this is the moment the app is doing its most
          important work. It used to be a sentence saying so and nothing else, which explained
          the pause but left it unmeasured — on a vault configured for a high cost that is
          several seconds of a window that looks stopped. The bar predicts the wait from this
          machine's previous unlocks and says so when it overruns.
        */}
        {busy && (
          <KdfProgressBar
            label="Unlocking your vault"
            subscribe={(listener) => window.keyhold.app.onKdfProgress(listener)}
          />
        )}

        <div className="kh-screen__actions">
          <Button variant="primary" type="submit" disabled={!canSubmit} loading={busy}>
            Unlock
          </Button>

          {quickUnlock?.enrolledForThisVault === true && path !== null && (
            <Button
              variant="secondary"
              disabled={busy || throttled}
              onClick={() => {
                void tryQuickUnlock(path);
              }}
            >
              {quickUnlock.promptsForBiometrics ? 'Use Touch ID' : 'Use quick unlock'}
            </Button>
          )}

          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              goTo('welcome');
            }}
          >
            Back
          </Button>
        </div>

        {pending !== null && pending.kdfMemoryKib >= 262_144 && (
          <p className="kh-screen__note">
            This vault uses a high key-derivation cost ({Math.round(pending.kdfMemoryKib / 1024)}{' '}
            MB), so unlocking may take several seconds.
          </p>
        )}
      </form>
    </div>
  );
}

function nameOf(path: string | null): string {
  if (path === null) return 'your vault';
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.keep$/i, '');
}

/**
 * Explains a lock the user did not initiate.
 *
 * Returning to a locked screen with no explanation is alarming — people reasonably wonder
 * whether something went wrong. Naming the reason turns it into the app doing its job.
 */
function describeLockReason(reason: string | null): string | null {
  // 'manual' and null need no explanation — the user did it, or nothing happened.
  if (reason === null) return null;

  switch (reason) {
    case 'idle':
      return 'Locked automatically after a period of inactivity.';
    case 'sleep':
      return 'Locked automatically when this computer went to sleep.';
    case 'screen-lock':
      return 'Locked automatically when you locked your screen.';
    case 'minimise':
      return 'Locked automatically when the window was minimised.';
    case 'blur':
      return 'Locked automatically when you switched to another app.';
    default:
      return null;
  }
}
