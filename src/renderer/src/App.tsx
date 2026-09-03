// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { ErrorState, LoadingState } from './components/Feedback.js';
import { AppearancePanel } from './settings/AppearancePanel.js';
import { CreateVaultScreen } from './vault/CreateVaultScreen.js';
import { UnlockScreen } from './vault/UnlockScreen.js';
import { VaultScreen } from './vault/VaultScreen.js';
import { WelcomeScreen } from './vault/WelcomeScreen.js';
import { CommandsProvider } from './commands/index.js';
import { startMenuBridge } from './shell/menu-bridge.js';
import { watchLockForTransfers } from './vault/transfer-store.js';
import { watchLockForToolViews, watchSelectionForToolViews } from './shell/index.js';
import { ClearToastsOnLock } from './vault/ClearToastsOnLock.js';
import { useSession, watchSession, type Screen } from './vault/session-store.js';
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

export function App(): React.JSX.Element {
  const { screen, status, refresh } = useSession();
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
      <CommandsProvider />
      <MenuBridge />
      <ScreenView screen={screen} />
    </>
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
