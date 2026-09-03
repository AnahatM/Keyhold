// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { ErrorState, LoadingState } from './components/Feedback.js';
import { AppearancePanel } from './settings/AppearancePanel.js';
import {
  OnboardingFlow,
  useFirstRunGate,
  useTourGate,
  type FirstCredentialDraft,
  type OnboardingMode,
} from './onboarding/index.js';
import { CreateVaultScreen } from './vault/CreateVaultScreen.js';
import { useCredentials } from './vault/credential-store.js';
import { UnlockScreen } from './vault/UnlockScreen.js';
import { VaultScreen } from './vault/VaultScreen.js';
import { WelcomeScreen } from './vault/WelcomeScreen.js';
import { CommandsProvider } from './commands/index.js';
import { startMenuBridge } from './shell/menu-bridge.js';
import { watchLockForTransfers } from './vault/transfer-store.js';
import { useToolView, watchLockForToolViews, watchSelectionForToolViews } from './shell/index.js';
import { ClearToastsOnLock } from './vault/ClearToastsOnLock.js';
import { useSession, watchSession, type Screen } from './vault/session-store.js';
import { useVaultActions } from './vault/vault-actions.js';
import './App.css';

/**
 * The root.
 *
 * Which screen shows is **derived from the session**, never stored alongside it — see
 * `session-store.ts`. An auto-lock can fire at any instant for reasons the renderer cannot
 * see, and a UI holding its own idea of "we are unlocked" will confidently render a vault
 * that is already closed.
 */
/**
 * Starts the native-menu subscription for the lifetime of the app.
 *
 * A component with no output rather than an effect inside `App`, for the same reason
 * `ClearToastsOnLock` is one: it belongs to the tree's lifetime, not to any screen, and
 * putting it beside the other two makes the set of global listeners a thing you can see in
 * one place rather than a growing list of effects at the top of a render function.
 */
function MenuBridge(): null {
  useEffect(() => startMenuBridge(), []);
  useEffect(() => watchLockForTransfers(), []);
  return null;
}

/**
 * Takes the user to the theme studio when the OS hands the app a `.keeptheme`.
 *
 * The studio polls for an opened theme when it mounts, so double-clicking one and *then*
 * opening Settings already worked. Without this, double-clicking a theme while looking at
 * anything else appears to do nothing at all — the app has the file and no screen says so,
 * which is the same shape as the extension being accepted with nothing on the other end.
 *
 * Only the navigation lives here. The file itself is collected by the studio's own poll once
 * it mounts, so one place stays responsible for reading it and this cannot deliver a theme
 * to a screen that is not showing one.
 */
function ThemeFileBridge(): null {
  useEffect(
    () =>
      window.keyhold.theme.onFileOpened(() => {
        useToolView.getState().open('settings');
      }),
    []
  );
  return null;
}

export function App(): React.JSX.Element {
  const { screen, status, refresh } = useSession();
  const vaultActions = useVaultActions();
  // Answered once per launch, from the first status that can answer it. Creating a vault
  // records it as opened, so a moment later the machine looks like a returning user's —
  // see `onboarding/onboarding-visibility.ts` for why this must not be re-derived per
  // render: the flow would unmount itself during its own vault-creation step.
  const firstRun = useFirstRunGate(status);
  const tour = useTourGate();
  const [bootError, setBootError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    // Subscribed BEFORE the first refresh, so a lock occurring during startup is not lost
    // in the gap between reading status and beginning to listen.
    const unwatch = watchSession();

    void refresh()
      .catch((error: unknown) => {
        setBootError(error instanceof Error ? error.message : 'Keyhold could not start.');
      })
      .finally(() => {
        setBooted(true);
      });

    return unwatch;
  }, [refresh]);

  // Mounted here rather than in the vault screen precisely because the vault screen is the
  // thing that unmounts on a lock: the tool view store outlives it, and an unlock that
  // reopened the health dashboard someone had left open would both skip the record list they
  // asked for and tell whoever is now at the keyboard what they had last been reading. A
  // subscription, not an effect body comparing renders — see `tool-view-store.ts`.
  useEffect(() => watchLockForToolViews(), []);

  // And the other half of the same idea: a tool view yields to a record the instant one is
  // selected or opened for editing, from wherever. Mounted at the root so it holds for the
  // palette and the shortcut table, which are mounted here and outlive every screen.
  useEffect(() => watchSelectionForToolViews(), []);

  if (bootError !== null) {
    return (
      <div className="kh-boot">
        <ErrorState
          title="Keyhold could not start"
          description={bootError}
          action={
            <button
              type="button"
              className="kh-button kh-button--secondary kh-button--md"
              onClick={() => {
                window.location.reload();
              }}
            >
              <span className="kh-button__label">Try again</span>
            </button>
          }
        />
      </div>
    );
  }

  if (!booted || status === null) {
    return (
      <div className="kh-boot">
        <LoadingState label="Starting Keyhold" rows={3} />
      </div>
    );
  }

  return (
    <>
      {/* Mounted outside the switch, so it is watching across every screen change — a lock
          is precisely the moment one screen is being replaced by another. */}
      <ClearToastsOnLock />
      {/* Likewise: the palette and the shortcut table are global, and the shortcut gate
          already refuses to fire vault commands while the vault is locked, so mounting them
          per-screen would only mean re-registering the same key listeners on every
          navigation. `focusSearch` and `toggleSidebar` belong to the vault screen's own
          state and are wired when that screen owns them. */}
      {/*
        The two handlers only the vault screen can supply, read from the store it registers
        them in. Both shortcuts were registered and inert before this — see `vault-actions.ts`.
      */}
      <CommandsProvider
        {...(vaultActions.focusSearch === null ? {} : { focusSearch: vaultActions.focusSearch })}
        {...(vaultActions.toggleSidebar === null
          ? {}
          : { toggleSidebar: vaultActions.toggleSidebar })}
      />
      <MenuBridge />
      <ThemeFileBridge />
      {/* Above the screen switch, not inside it: the flow spans the states the switch is
          made of — it begins with no vault and ends with one open — so putting it in a
          `case` would unmount it at the moment it succeeded. */}
      {firstRun.show ? (
        <FirstRunFlow onExit={firstRun.close} />
      ) : (
        <>
          <ScreenView screen={screen} />
          {/*
            Over the vault screen rather than instead of it, and only there.

            Three of the five steps describe an open vault and one of them writes to it, so a
            re-run on the welcome or unlock screen would be describing something that is not
            on the other side of it. The guard is what the screen is, not whether a status
            field says unlocked, because that is the same thing the screen is derived from
            and one condition cannot disagree with itself.

            The re-run writes no progress — see `initialStateFor` — so closing it cannot
            rewrite a first run's `completed` record as `dismissed`.
          */}
          {tour.open && screen === 'vault' && <FirstRunFlow mode="revisit" onExit={tour.close} />}
        </>
      )}
    </>
  );
}

/**
 * The first-run flow, wired to the session.
 *
 * The flow owns no vault and opens no dialog by design — that is its contract, and it is
 * what makes it testable against an in-memory fake. So everything irreversible happens here.
 *
 * Three of its callbacks are deliberately not supplied. `onImport`, `onEnableQuickUnlock`
 * and `onOpenAutoLockSettings` open surfaces that exist only inside the unlocked vault
 * screen, so wiring them from here would open a panel *behind* the flow — a control that
 * appears to do nothing. Left off, each card renders the sentence naming where the thing
 * lives instead, which is the honest version.
 */
function FirstRunFlow({
  mode = 'first-run',
  onExit,
}: {
  readonly mode?: OnboardingMode;
  readonly onExit: () => void;
}): React.JSX.Element {
  const { status, workingPath, busy, error, estimateStrength } = useSession();
  const quickUnlock = status?.quickUnlock ?? null;

  return (
    <OnboardingFlow
      mode={mode}
      // Null until the vault exists; the flow re-scopes its stored progress when it changes.
      vaultKey={status?.vault?.vaultId ?? null}
      vaultPath={status?.vault?.path ?? workingPath}
      estimateStrength={estimateStrength}
      onCreateVault={async (secret) => {
        // The flow shows the path and never chooses it. A first run has no location yet, so
        // the OS dialog opens here, at the moment the user commits rather than before.
        const session = useSession.getState();
        if (session.workingPath === null) {
          await session.chooseNewVaultLocation();
          if (useSession.getState().workingPath === null) {
            // Cancelling has to say something. A Create button that silently does nothing is
            // the dead end the step's own blocker copy exists to prevent.
            useSession.getState().setError('Choose where to save your vault file to continue.');
            return false;
          }
        }
        return useSession.getState().createVault(secret);
      }}
      onCreateFirstCredential={async (draft: FirstCredentialDraft) => {
        // Empty optionals are omitted rather than sent as `''`: `exactOptionalPropertyTypes`
        // is on, and an empty string is a value while an absent field is not.
        const created = await useCredentials.getState().create({
          title: draft.title,
          ...(draft.username === '' ? {} : { username: draft.username }),
          ...(draft.url === '' ? {} : { urls: [draft.url] }),
          ...(draft.secretPassword === '' ? {} : { password: draft.secretPassword }),
        });
        return created !== null;
      }}
      {...(quickUnlock?.available === true ? { quickUnlockName: quickUnlock.mechanism } : {})}
      busy={busy}
      error={error}
      onExit={onExit}
    />
  );
}

function ScreenView({ screen }: { readonly screen: Screen }): React.JSX.Element {
  switch (screen) {
    case 'create':
      return <CreateVaultScreen />;
    case 'unlock':
      return <UnlockScreen />;
    case 'vault':
      return <VaultScreen appearancePanel={<AppearancePanel />} />;
    case 'welcome':
      return <WelcomeScreen />;
  }
}
