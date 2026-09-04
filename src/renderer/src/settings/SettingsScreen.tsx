// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo, useState } from 'react';
import type { SettingsGateway } from '@shared/model/settings-plan.js';
import { Button } from '../components/Button.js';
import { ErrorState, LoadingState } from '../components/Feedback.js';
import { ConfirmDialog } from '../chrome/index.js';
import { ThemeStudio } from '../theme-studio/index.js';
import { AppearancePanel } from './AppearancePanel.js';
import { DangerZoneSection } from './DangerZoneSection.js';
import { HealthRulesSection } from './HealthRulesSection.js';
import { HelpSection } from './HelpSection.js';
import { HistoryAuditSection } from './HistoryAuditSection.js';
import { MasterPasswordSection } from './MasterPasswordSection.js';
import { SecuritySessionSection } from './SecuritySessionSection.js';
import { VaultSection } from './VaultSection.js';
import { ScopeBadge } from './SettingControls.js';
import { createBridgeGateway } from './settings-gateway.js';
import { SCOPE_NOTES } from './settings-copy.js';
import { useSettings } from './use-settings.js';
import './settings.css';
import { Icon } from '../components/Icon.js';

/**
 * Everything the user can configure, in one place.
 *
 * The organising idea is the one the app's promise depends on: **you decide your own
 * security/convenience trade-off**, which only works if every trade is visible. So the
 * screen does three things no ordinary preferences pane does.
 *
 * **It says where each setting is stored.** Machine settings sit in Keyhold's own
 * preferences file and stay on this computer; vault settings are written inside the
 * encrypted body and travel with the file to any machine it is copied to. That distinction
 * is invisible in every password manager that has both, and a user who does not know it
 * will eventually be surprised by a security setting — which is the whole problem this
 * screen exists to prevent. The legend at the top says it once; every control repeats it.
 *
 * **It names the cost of the looser option, beside the control.** Not in a help page.
 *
 * **Every default is the safe one**, and the reset buttons restore exactly those defaults —
 * they are `DEFAULT_MACHINE_SETTINGS` and `DEFAULT_CONFIGURABLE_VAULT_SETTINGS`, the same
 * constants the main process starts from, so "reset" cannot drift into meaning something
 * else.
 *
 * Appearance is mounted, not reimplemented: `AppearancePanel` already owns theme, accent,
 * density and motion, and it was built first precisely so everything after it would be
 * token-driven.
 *
 * ## Nothing here is a secret
 *
 * No control on this screen displays, requests or caches secret material, with one
 * unavoidable exception: the two flows that need the master password to re-derive a key
 * take it, use it for one call, and clear it. They never echo it, never announce it, and
 * never put it in an error.
 */

interface NavEntry {
  readonly id: string;
  readonly label: string;
}

export interface SettingsScreenProps {
  /** Injected so the screen can be driven by an in-memory gateway in tests. */
  readonly gateway?: SettingsGateway;
  /**
   * Drop the `<h2>` because the frame around this screen already shows the name.
   *
   * The same prop the other tool views take. Only the title goes — the subtitle and the
   * scope legend stay, because they explain what the screen is *for* and the frame's title
   * does not.
   */
  readonly hideTitle?: boolean;
}

export function SettingsScreen({
  gateway,
  hideTitle = false,
}: SettingsScreenProps): React.JSX.Element {
  // Memoised so the identity is stable: the loading effect keys off the gateway, and a new
  // object each render would re-read the settings forever.
  const resolved = useMemo(() => gateway ?? createBridgeGateway(), [gateway]);
  const controller = useSettings(resolved);
  const [resetting, setResetting] = useState<'machine' | 'vault' | null>(null);

  const { snapshot, loading, loadError } = controller;

  const sections: readonly NavEntry[] = useMemo(() => {
    const entries: NavEntry[] = [
      { id: 'kh-settings-appearance', label: 'Appearance' },
      { id: 'kh-settings-theme-studio', label: 'Theme studio' },
      { id: 'kh-settings-security', label: 'Security & session' },
    ];
    if (snapshot?.vault != null) {
      entries.push(
        { id: 'kh-settings-history', label: 'History & audit' },
        { id: 'kh-settings-health', label: 'Health rules' },
        { id: 'kh-settings-vault', label: 'Vault' }
      );
    }
    entries.push({ id: 'kh-settings-danger', label: 'Advanced' });
    return entries;
  }, [snapshot]);

  if (loading) {
    return (
      <div className="kh-settings">
        <LoadingState label="Reading your settings" rows={4} />
      </div>
    );
  }

  if (loadError !== null || snapshot === null) {
    return (
      <div className="kh-settings">
        <ErrorState
          title="Settings could not be read"
          description={loadError ?? 'Keyhold did not get an answer back.'}
          action={
            <Button variant="secondary" onClick={controller.reload}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="kh-settings">
      {/*
        One polite live region for the whole screen. The controls apply immediately, which
        gives a sighted user instant feedback and a screen-reader user none at all — so
        every successful change, and every failure, is announced here. Re-keyed on `seq` so
        an identical message twice in a row is still read out.
      */}
      <div className="kh-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        <span key={controller.announcement.seq}>{controller.announcement.text}</span>
      </div>

      <header className="kh-settings__header">
        {!hideTitle && <h2 className="kh-settings__title">Settings</h2>}
        <p className="kh-settings__subtitle">
          Keyhold is meant to be configurable rather than opinionated: every behaviour here is yours
          to choose, and every choice that costs you something says so.
        </p>

        <dl className="kh-scope-legend">
          <div>
            <dt>
              <ScopeBadge scope="machine" />
            </dt>
            <dd>{SCOPE_NOTES.machine}</dd>
          </div>
          <div>
            <dt>
              <ScopeBadge scope="vault" />
            </dt>
            <dd>{SCOPE_NOTES.vault}</dd>
          </div>
        </dl>
      </header>

      <nav className="kh-settings__nav" aria-label="Settings sections">
        <ul>
          {sections.map((entry) => (
            <li key={entry.id}>
              {/*
                A link, not a button: it works with the browser's own in-page navigation, is
                announced as a link, and lands focus on the section — which has tabIndex={-1}
                for exactly that. Scrolling without moving focus leaves a keyboard user where
                they were, staring at content they cannot reach with Tab.
              */}
              <a className="kh-settings__nav-link" href={`#${entry.id}`}>
                {entry.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {controller.saveError !== null && (
        <p className="kh-settings__error" role="alert">
          <Icon name="warning" size="sm" /> Not saved — {controller.saveError}
        </p>
      )}

      <div className="kh-settings__body">
        <div id="kh-settings-appearance" tabIndex={-1}>
          <AppearancePanel />
        </div>

        <div id="kh-settings-theme-studio" tabIndex={-1}>
          <ThemeStudio />
        </div>

        <SecuritySessionSection
          controller={controller}
          machine={snapshot.machine}
          quickUnlock={snapshot.quickUnlock}
          hasVault={snapshot.vault !== null}
        />

        {snapshot.vault === null ? (
          <p className="kh-callout kh-callout--vault">
            <span className="kh-callout__symbol" aria-hidden="true">
              <Icon name="lock" size="lg" />
            </span>
            <span>
              History, health rules and vault settings live inside a vault file, so they appear once
              a vault is open. The settings above are stored on this computer and can be changed at
              any time.
            </span>
          </p>
        ) : (
          <>
            <HistoryAuditSection controller={controller} vault={snapshot.vault} />
            <HealthRulesSection controller={controller} vault={snapshot.vault} />
            <VaultSection
              controller={controller}
              vault={snapshot.vault}
              vaultPath={snapshot.vaultPath}
              kdf={snapshot.kdf}
              quickUnlockEnrolled={snapshot.quickUnlock.enrolled}
            />
            {/* After the vault section, because the KDF cost above it is the other half of
                the same subject — how expensive this vault is to open — and a reader who has
                just been told what the cost means is the reader ready to change the password
                it protects. Before the danger zone, because changing a password is not one. */}
            <MasterPasswordSection
              controller={controller}
              hasVault
              quickUnlockEnrolled={snapshot.quickUnlock.enrolled}
            />
            {/* Inside the open-vault branch: the tour's later steps describe a vault that
                exists, and `App.tsx` only mounts a re-run over the vault screen anyway. */}
            <HelpSection />
          </>
        )}

        <DangerZoneSection
          controller={controller}
          quickUnlock={snapshot.quickUnlock}
          historyVersionCount={snapshot.historyVersionCount}
          hasVault={snapshot.vault !== null}
        />
      </div>

      <footer className="kh-settings__footer">
        <p className="kh-settings__footer-note">
          Every default in Keyhold is the safer option. Resetting restores exactly those defaults —
          nothing is switched off in the process.
        </p>
        <div className="kh-settings__footer-actions">
          <Button
            variant="secondary"
            disabled={controller.busy}
            onClick={() => {
              setResetting('machine');
            }}
          >
            Reset settings for this computer
          </Button>
          <Button
            variant="secondary"
            disabled={controller.busy || snapshot.vault === null}
            onClick={() => {
              setResetting('vault');
            }}
          >
            Reset settings stored in this vault
          </Button>
        </div>
      </footer>

      <ConfirmDialog
        open={resetting !== null}
        title={
          resetting === 'vault'
            ? 'Reset the settings stored in this vault?'
            : 'Reset the settings for this computer?'
        }
        message={
          resetting === 'vault'
            ? 'History retention, the audit privacy level, the health rules and the trash policy go back to Keyhold’s defaults. The unlock cost and your credentials are not touched.'
            : 'Auto-lock, the clipboard timer, the reveal limit and the erase-after-failures setting go back to Keyhold’s defaults. Your appearance choices and your vault are not touched.'
        }
        consequence="Every Keyhold default is the safer choice, so this can only tighten your settings — but any deliberate loosening you had chosen will be undone."
        confirmLabel="Restore defaults"
        busy={controller.busy}
        onCancel={() => {
          setResetting(null);
        }}
        onConfirm={() => {
          const which = resetting;
          setResetting(null);
          if (which === 'vault') controller.resetVault();
          else if (which === 'machine') controller.resetMachine();
        }}
      />
    </div>
  );
}
