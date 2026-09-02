// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState, type ReactNode } from 'react';
import { Badge, EmptyState } from '../components/Feedback.js';
import { Button } from '../components/Button.js';
import { AppShell } from '../shell/AppShell.js';
import { useSession } from './session-store.js';
import './vault-screens.css';

/**
 * The unlocked vault.
 *
 * Credential CRUD arrives in Phase 5; what this renders today is the shell around it — the
 * lock control, the vault header, the clipboard countdown, and the quick-unlock enrolment
 * offer. Those belong to the *session*, not to credentials, which is why they land now
 * rather than waiting.
 */
export function VaultScreen({
  appearancePanel,
}: {
  readonly appearancePanel: ReactNode;
}): React.JSX.Element {
  const { status, credentials, lock } = useSession();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const vault = status?.vault ?? null;
  const quickUnlock = status?.quickUnlock;

  return (
    <AppShell
      sidebarCollapsed={sidebarCollapsed}
      onSidebarCollapsedChange={setSidebarCollapsed}
      sidebar={
        <div className="kh-sidebar">
          <header className="kh-sidebar__header">
            <span className="kh-sidebar__mark" aria-hidden="true">
              🔓
            </span>
            <div>
              <div className="kh-sidebar__name">{vault?.displayName ?? 'Vault'}</div>
              <div className="kh-sidebar__version">
                {vault === null
                  ? ''
                  : `${vault.recordCount} item${vault.recordCount === 1 ? '' : 's'}`}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              iconOnlyLabel="Collapse the sidebar"
              onClick={() => {
                setSidebarCollapsed(true);
              }}
            >
              ‹
            </Button>
          </header>

          <nav className="kh-sidebar__nav">
            <div className="kh-sidebar__group">Vault</div>
            {[
              { label: 'All items', count: vault?.recordCount ?? 0 },
              { label: 'Favourites', count: 0 },
              { label: 'Trash', count: vault?.trashedCount ?? 0 },
            ].map((item) => (
              <button key={item.label} type="button" className="kh-sidebar__item" disabled>
                <span>{item.label}</span>
                <span className="kh-sidebar__count">{item.count}</span>
              </button>
            ))}
            <p className="kh-sidebar__note">Folders and tags arrive in Phase 7.</p>
          </nav>

          <div className="kh-sidebar__footer">
            <ClipboardIndicator />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void lock();
              }}
            >
              Lock vault
            </Button>
          </div>
        </div>
      }
      list={
        <div className="kh-list">
          <header className="kh-list__header">
            <h1 className="kh-list__title">Credentials</h1>
            <Badge tone="info" symbol="●">
              Phase 4
            </Badge>
          </header>

          {credentials.length === 0 ? (
            <EmptyState
              icon="🗝"
              title="This vault is empty"
              description="Adding, editing and deleting credentials arrives in Phase 5. The vault itself is real — it is encrypted on disk and it just opened."
            />
          ) : (
            <ul className="kh-credential-list">
              {credentials.map((credential) => (
                <li key={credential.id} className="kh-credential-list__item">
                  <span className="kh-credential-list__title">{credential.title}</span>
                  <span className="kh-credential-list__subtitle">
                    {credential.username || credential.email || '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      }
      detail={
        <div className="kh-detail-stack">
          {vault !== null && (
            <section className="kh-panel">
              <header className="kh-panel__header">
                <h2 className="kh-panel__title">{vault.displayName}</h2>
                <p className="kh-panel__subtitle">
                  <code className="kh-path">{vault.path}</code>
                </p>
              </header>

              <dl className="kh-vault-facts">
                <div>
                  <dt>Items</dt>
                  <dd>{vault.recordCount}</dd>
                </div>
                <div>
                  <dt>In trash</dt>
                  <dd>{vault.trashedCount}</dd>
                </div>
                <div>
                  <dt>Attachments</dt>
                  <dd>{vault.attachmentCount}</dd>
                </div>
                <div>
                  <dt>Saves</dt>
                  <dd>{vault.generation}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{new Date(vault.createdAt).toLocaleDateString()}</dd>
                </div>
                <div>
                  <dt>Last saved</dt>
                  <dd>{new Date(vault.modifiedAt).toLocaleString()}</dd>
                </div>
              </dl>

              {quickUnlock !== undefined && quickUnlock.available && (
                <QuickUnlockCard
                  description={quickUnlock.description}
                  enrolled={quickUnlock.enrolledForThisVault}
                  promptsForBiometrics={quickUnlock.promptsForBiometrics}
                />
              )}
            </section>
          )}

          {appearancePanel}
        </div>
      }
    />
  );
}

/**
 * Quick-unlock enrolment.
 *
 * The description comes from the main process rather than being written here, because it
 * differs by platform in a way that matters: Touch ID is a real biometric gate, Windows
 * DPAPI is not. Hardcoding "use biometrics" in the UI is exactly how that distinction gets
 * lost — see `quick-unlock.ts`.
 */
function QuickUnlockCard({
  description,
  enrolled,
  promptsForBiometrics,
}: {
  readonly description: string;
  readonly enrolled: boolean;
  readonly promptsForBiometrics: boolean;
}): React.JSX.Element {
  const { refresh } = useSession();
  const [busy, setBusy] = useState(false);

  const toggle = async (): Promise<void> => {
    setBusy(true);
    try {
      if (enrolled) {
        await window.keyhold.session.revokeQuickUnlock();
      } else {
        await window.keyhold.session.enrolQuickUnlock();
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="kh-quick-unlock">
      <h3 className="kh-panel__heading">
        {promptsForBiometrics ? 'Touch ID unlock' : 'Quick unlock'}
      </h3>
      <p className="kh-panel__hint">{description}</p>
      <Button
        variant={enrolled ? 'secondary' : 'primary'}
        size="sm"
        loading={busy}
        onClick={() => {
          void toggle();
        }}
      >
        {enrolled ? 'Turn off for this vault' : 'Turn on for this vault'}
      </Button>
      {enrolled && (
        <p className="kh-panel__hint">
          Your master password still works, and re-keying this vault turns quick unlock off
          automatically.
        </p>
      )}
    </section>
  );
}

/**
 * The clipboard countdown.
 *
 * Shown because an invisible timer is not a feature anyone can rely on: without it, a user
 * cannot tell whether their password is still on the clipboard or already gone, and will
 * either paste into nothing or assume it lingers forever.
 */
function ClipboardIndicator(): React.JSX.Element | null {
  const { status, refresh } = useSession();

  // An absolute deadline from the main process, minus a ticking clock — same reasoning as
  // UnlockScreen. Two counters for one fact drift the moment a refresh lands mid-tick, and
  // deriving the deadline here would mean an impure `Date.now()` during render.
  const clearsAt = status?.clipboard.clearsAt ?? null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (clearsAt === null) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      // One refresh as it expires, so the main process's view and this one agree rather
      // than the indicator quietly outliving the clipboard it describes.
      if (current >= clearsAt) void refresh();
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, [clearsAt, refresh]);

  const remaining = clearsAt === null ? null : Math.max(0, clearsAt - now);
  if (status?.clipboard.hasSecret !== true || remaining === null || remaining <= 0) return null;

  return (
    <p className="kh-clipboard" aria-live="polite">
      <span aria-hidden="true">📋</span> Clipboard clears in {Math.ceil(remaining / 1000)}s
    </p>
  );
}
