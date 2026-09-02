// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../components/Button.js';
import { AppShell } from '../shell/AppShell.js';
import { CredentialDetail, NoSelection } from './CredentialDetail.js';
import { CredentialEditor } from './CredentialEditor.js';
import { CredentialList } from './CredentialList.js';
import { useCredentials } from './credential-store.js';
import { useSession } from './session-store.js';
import './vault-screens.css';

/**
 * The unlocked vault.
 *
 * The three-pane shell: the vault sidebar, the credential list, and the detail pane, plus
 * the lock control, the vault header, the clipboard countdown and the quick-unlock
 * enrolment offer. Those last four belong to the *session* rather than to any credential,
 * which is why they live here rather than in the detail pane.
 */
export function VaultScreen({
  appearancePanel,
}: {
  readonly appearancePanel: ReactNode;
}): React.JSX.Element {
  const { status, credentials, lock } = useSession();
  const { selectedId, editing, select, setShowTrash, showTrash } = useCredentials();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const selected = credentials.find((credential) => credential.id === selectedId);
  const vault = status?.vault ?? null;

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
            <button
              type="button"
              className="kh-sidebar__item"
              aria-current={!showTrash}
              onClick={() => {
                setShowTrash(false);
              }}
            >
              <span>All items</span>
              <span className="kh-sidebar__count">{vault?.recordCount ?? 0}</span>
            </button>
            <button
              type="button"
              className="kh-sidebar__item"
              aria-current={showTrash}
              onClick={() => {
                setShowTrash(true);
              }}
            >
              <span>Trash</span>
              <span className="kh-sidebar__count">{vault?.trashedCount ?? 0}</span>
            </button>
            <p className="kh-sidebar__note">
              Folders, tags and favourites are built but not yet wired to this list.
            </p>
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
      hasSelection={selectedId !== null || editing}
      onBack={() => {
        select(null);
      }}
      list={<CredentialList />}
      detail={
        <div className="kh-detail-stack">
          <UndoBar />
          {editing ? (
            <CredentialEditor credential={selected ?? null} />
          ) : selected !== undefined ? (
            <CredentialDetail credential={selected} />
          ) : (
            <>
              <NoSelection />
              <VaultOverview />
              {appearancePanel}
            </>
          )}
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

/**
 * Vault-level facts and the quick-unlock offer.
 *
 * Shown when nothing is selected rather than always: with a record open, the record is
 * what the user came for, and a panel of vault statistics above it is noise.
 */
function VaultOverview(): React.JSX.Element | null {
  const { status } = useSession();
  const vault = status?.vault ?? null;
  const quickUnlock = status?.quickUnlock;

  if (vault === null) return null;

  return (
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
  );
}

/**
 * The undo affordance for a destructive action.
 *
 * Every destructive action here offers undo, which is only possible because the operations
 * are non-destructive underneath — trashing sets a flag, so undo clears it. Permanent
 * deletion is the one exception, and is therefore the one action that asks first instead.
 */
function UndoBar(): React.JSX.Element | null {
  const { lastAction, clearUndo, busy } = useCredentials();
  if (lastAction === null) return null;

  return (
    <div className="kh-undo" role="status">
      <span>{lastAction.label}</span>
      <Button
        variant="secondary"
        size="sm"
        disabled={busy}
        onClick={() => {
          void lastAction.undo();
        }}
      >
        Undo
      </Button>
      <Button variant="ghost" size="sm" iconOnlyLabel="Dismiss" onClick={clearUndo}>
        ✕
      </Button>
    </div>
  );
}
