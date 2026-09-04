// SPDX-License-Identifier: GPL-3.0-or-later
import { Button } from '../components/Button.js';
import { Icon } from '../components/Icon.js';
import { useSession } from './session-store.js';
import './vault-screens.css';

/**
 * The first thing anyone sees.
 *
 * Two jobs, in this order: get an existing user back into their vault in one click, and
 * give a new user enough context to make the create decision without reading a manual.
 *
 * The recent-vaults list is the primary path because that is the overwhelmingly common
 * case — someone opening the app they use every day. "Create" is prominent but secondary,
 * which is the opposite of what a screen designed around a first-run flow would do.
 */
export function WelcomeScreen(): React.JSX.Element {
  const { status, busy, error, chooseExistingVault, chooseNewVaultLocation, forgetVault, goTo } =
    useSession();

  const recent = status?.recentVaults ?? [];

  return (
    <div className="kh-screen">
      <div className="kh-screen__panel">
        <header className="kh-screen__header">
          <Icon name="shield" size="lg" className="kh-screen__mark" />
          <h1 className="kh-screen__title">Keyhold</h1>
          <p className="kh-screen__subtitle">
            Your passwords, in a file you own, encrypted with a key only you have.
          </p>
        </header>

        {error !== null && (
          <p className="kh-screen__error" role="alert">
            {error}
          </p>
        )}

        {recent.length > 0 && (
          <section className="kh-screen__section">
            <h2 className="kh-screen__heading">Recent vaults</h2>
            <ul className="kh-recent">
              {recent.map((vault) => (
                <li key={vault.path} className="kh-recent__item">
                  <button
                    type="button"
                    className="kh-recent__open"
                    disabled={busy}
                    onClick={() => {
                      goTo('unlock', vault.path);
                      void useSession.getState().tryQuickUnlock(vault.path);
                    }}
                  >
                    <span className="kh-recent__name">{vault.displayName}</span>
                    {/* The full path is the only way to tell two vaults with the same
                        name apart, and it is not secret — it is on the user's own disk. */}
                    <span className="kh-recent__path" title={vault.path}>
                      {vault.path}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnlyLabel={`Remove ${vault.displayName} from this list`}
                    disabled={busy}
                    onClick={() => {
                      void forgetVault(vault.path);
                    }}
                  >
                    <Icon name="close" size="sm" />
                  </Button>
                </li>
              ))}
            </ul>
            <p className="kh-screen__note">
              Removing a vault from this list does not delete it. The file stays where it is.
            </p>
          </section>
        )}

        <section className="kh-screen__section kh-screen__actions">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              void chooseExistingVault();
            }}
          >
            Open a vault…
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              void chooseNewVaultLocation();
            }}
          >
            Create a new vault…
          </Button>
        </section>

        <section className="kh-screen__section">
          <ul className="kh-facts">
            <li>
              <strong>One file.</strong> Copy it to a USB stick, a cloud folder, or another machine.
              It opens anywhere, with your master password.
            </li>
            <li>
              <strong>No account, no server.</strong> Keyhold makes no network requests at all
              unless you switch one on.
            </li>
            <li>
              <strong>No recovery.</strong> Nobody — including us — can open your vault without your
              master password. That is the point, and it is also the risk.
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
