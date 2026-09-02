// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { ErrorState, LoadingState } from './components/Feedback.js';
import { AppearancePanel } from './settings/AppearancePanel.js';
import { CreateVaultScreen } from './vault/CreateVaultScreen.js';
import { UnlockScreen } from './vault/UnlockScreen.js';
import { VaultScreen } from './vault/VaultScreen.js';
import { WelcomeScreen } from './vault/WelcomeScreen.js';
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
