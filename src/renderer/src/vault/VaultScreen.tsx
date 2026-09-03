// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CredentialProjection } from '@shared/model/credential.js';
import { Button } from '../components/Button.js';
import { ContentViewer } from '../content/index.js';
import { GeneratorScreen } from '../generator/index.js';
import { HealthDashboard } from '../health/HealthDashboard.js';
import { ExportDialog } from '../export/ExportDialog.js';
import { exportGatewayFrom } from '../export/export-gateway.js';
import { ImportWizard } from '../import/ImportWizard.js';
import { createIpcImportGateway } from '../import/ipc-gateway.js';
import { OrganisationSidebar } from '../organisation/index.js';
import { useOrganisation } from '../organisation/organisation-store.js';
import {
  ExternalChangeBanner,
  MergeFlow,
  createIpcSyncGateway,
  targetNamesFrom,
  type MergeTargetNames,
} from '../sync/index.js';
import { SettingsScreen } from '../settings/SettingsScreen.js';
import {
  AppShell,
  TOOL_VIEW_BY_ID,
  ToolNav,
  ToolView,
  useToolView,
  type ToolViewId,
} from '../shell/index.js';
import { CredentialDetail, NoSelection } from './CredentialDetail.js';
import { CredentialEditor } from './CredentialEditor.js';
import { CredentialList } from './CredentialList.js';
import { useCredentials } from './credential-store.js';
import { useSession } from './session-store.js';
import { useTransfer } from './transfer-store.js';
import './vault-screens.css';

/**
 * The unlocked vault.
 *
 * The three-pane shell: the vault sidebar, the credential list, and the detail pane, plus
 * the lock control, the vault header, the clipboard countdown and the quick-unlock
 * enrolment offer. Those last four belong to the *session* rather than to any credential,
 * which is why they live here rather than in the detail pane.
 *
 * ## And the tool views
 *
 * Health, the generator and help are not about a record, so they do not live in a pane
 * sized for one — opening one hands it the whole main region and leaves the sidebar
 * standing, which is the same trade the shell already makes when a narrow window lets the
 * detail pane take over from the list. See `shell/tool-views.ts` for the reasoning and
 * `ToolView` for the frame.
 *
 * The mapping from id to component is the one exhaustive switch in the app: the registry is
 * data, so a fifth tool added there fails to compile here until it is given something to
 * mount. That is deliberate — the alternative is a route that silently renders nothing.
 */
export function VaultScreen({
  appearancePanel,
}: {
  readonly appearancePanel: ReactNode;
}): React.JSX.Element {
  const { status, credentials, lock, reloadFromDisk } = useSession();
  // `showTrash` moved to the sidebar with the rest of the view selection; this screen
  // keeps only what it still owns.
  const { selectedId, editing, select, setShowTrash } = useCredentials();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const openTransfer = useTransfer((state) => state.open);
  const folders = useOrganisation((state) => state.folders);
  const tags = useOrganisation((state) => state.tags);

  // Names for the merge resolver, built from lists this screen already has. Memoised because
  // the resolver renders one row per conflict and a fresh map each render would rebuild every
  // one of them; a large merge is exactly where that stops being free.
  //
  // Titles, folder names and tag names only — the resolver is shown lengths where a value
  // would be, and this is the safe projection it draws its labels from.
  const mergeNames = useMemo(
    () => targetNamesFrom({ records: credentials, folders, tags }),
    [credentials, folders, tags]
  );

  const activeToolId = useToolView((state) => state.active);
  const closeTool = useToolView((state) => state.close);
  const activeTool = activeToolId === null ? null : (TOOL_VIEW_BY_ID.get(activeToolId) ?? null);

  const selected = credentials.find((credential) => credential.id === selectedId);
  const vault = status?.vault ?? null;

  /**
   * A health finding, opened as a record.
   *
   * The dashboard's whole point is that a finding is actionable, so selecting one leaves the
   * tool rather than selecting a record behind a screen that is covering it. Trash is
   * cleared for the same reason the palette clears it: the analysis only covers live
   * records, so landing in the trash view would show an empty list and no explanation.
   */
  const refresh = useSession((state) => state.refresh);

  const openRecordFromTool = (credentialId: string): void => {
    setShowTrash(false);
    select(credentialId);
    closeTool();
  };

  return (
    <>
      <AppShell
        banner={
          <ExternalChangeBanner
            hasUnsavedChanges={status?.hasUnsavedChanges ?? false}
            subscribe={(listener) => window.keyhold.app.onVaultChangedExternally(listener)}
            onReload={() => {
              void reloadFromDisk();
            }}
            onMerge={() => {
              openTransfer('merge');
            }}
            onLock={() => {
              void lock();
            }}
          />
        }
        sidebarCollapsed={sidebarCollapsed}
        onSidebarCollapsedChange={setSidebarCollapsed}
        main={
          activeTool === null ? undefined : (
            <ToolView view={activeTool} onClose={closeTool}>
              <ToolPane
                id={activeTool.id}
                records={credentials}
                onSelectCredential={openRecordFromTool}
              />
            </ToolView>
          )
        }
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

            {/*
            The real sidebar, replacing the placeholder nav that used to live here.
            It owns no filtering: it produces a `SidebarSelection`, and `visibleForSelection`
            turns that into a list through the shared search engine — so there is still one
            matcher and one sort in the app.
          */}
            <OrganisationSidebar />

            {/*
            The tools, below the folders and above the lock control. A palette command and a
            menu item are both invisible until you already know they exist, and a finished
            screen nobody can find is not much better than one nobody mounted.
          */}
            <ToolNav />

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
      <TransferFlows
        selectedIds={selectedId === null ? [] : [selectedId]}
        onImported={() => {
          void refresh();
        }}
        names={mergeNames}
        onOpenRecord={(recordId) => {
          select(recordId);
        }}
      />
    </>
  );
}

/**
 * The tool view registry's one mapping to components.
 *
 * Exhaustive over `ToolViewId` with no `default` branch, so adding a fifth entry to
 * `TOOL_VIEWS` is a compile error here rather than a nav row that opens an empty page.
 *
 * Each tool is mounted with its own page title suppressed: `ToolView` renders the `<h1>`
 * because that is what focus moves to on navigation, and it has to exist above whatever is
 * mounted inside it. Two page titles stacked on each other reads as a bug.
 *
 * **Nothing here is handed a secret.** The health dashboard receives projections and a
 * callback; the help viewer receives nothing at all; the generator's one secret is produced
 * in the main process, held by its own panel, and cleared on lock by the subscription in
 * `use-generator.ts` — this screen never sees it and deliberately passes no `onUse`, because
 * on a standalone generator there is nowhere for a password to go.
 */
/**
 * The import wizard and the export dialog, mounted.
 *
 * Both were finished, both were bound to registered channels, and neither was rendered
 * anywhere — the largest built-but-unreachable gap in the app. They are mounted here, in the
 * vault screen, because both act on an open vault and neither means anything without one.
 *
 * Rendered only while their flow is active rather than always-mounted-with-`open={false}`.
 * That is not a performance choice: the wizard holds a decrypted file, and a component that
 * is merely hidden is a component still holding it. Unmounting is what makes "closed" mean
 * the same thing as "gone", and the wizard's own discard-on-unmount is what makes that safe.
 *
 * The gateways are built per render and that is fine — both are stateless adapters over
 * `window.keyhold`, holding nothing between calls, so a fresh one costs an object. The state
 * that matters lives in the main process, which is the whole point of the split.
 */
function TransferFlows({
  selectedIds,
  onImported,
  names,
  onOpenRecord,
}: {
  readonly selectedIds: readonly string[];
  readonly onImported: () => void;
  /** Built by the caller, which is the component that already holds the vault's lists. */
  readonly names: MergeTargetNames;
  readonly onOpenRecord: (recordId: string) => void;
}): React.JSX.Element | null {
  const active = useTransfer((state) => state.active);
  const close = useTransfer((state) => state.close);

  if (active === 'import') {
    return (
      <ImportWizard
        open
        gateway={createIpcImportGateway(window.keyhold.importer)}
        onClose={close}
        onImported={() => {
          // The list is stale the moment a commit lands: the records are in the vault and the
          // renderer's projection is not. Refreshing here rather than inside the wizard keeps
          // the wizard ignorant of the credential store, which is what lets it be driven by a
          // fake gateway in its own tests.
          onImported();
        }}
      />
    );
  }

  if (active === 'export') {
    return (
      <ExportDialog
        open
        gateway={exportGatewayFrom(
          window.keyhold.exporter,
          window.keyhold.session.estimateStrength
        )}
        selectedIds={selectedIds}
        onClose={close}
      />
    );
  }

  if (active === 'merge') {
    return (
      <MergeFlow
        gateway={createIpcSyncGateway(window.keyhold.sync)}
        names={names}
        subscribeToKdfProgress={(listener) => window.keyhold.app.onKdfProgress(listener)}
        onClose={close}
        onApplied={() => {
          // A merge rewrites the vault body, so every projection the renderer holds is stale
          // — not just the list. Same refresh the import wizard uses, for the same reason.
          onImported();
        }}
        onOpenRecord={onOpenRecord}
      />
    );
  }

  return null;
}

function ToolPane({
  id,
  records,
  onSelectCredential,
}: {
  readonly id: ToolViewId;
  readonly records: readonly CredentialProjection[];
  readonly onSelectCredential: (credentialId: string) => void;
}): React.JSX.Element {
  switch (id) {
    case 'generator':
      return <GeneratorScreen hideTitle />;
    case 'health':
      return (
        <HealthDashboard records={records} onSelectCredential={onSelectCredential} hideTitle />
      );
    case 'settings':
      // No gateway prop: the screen memoises its own `createBridgeGateway()` when none is
      // given, and passing a fresh one from here on every render would re-trigger its
      // loading effect forever — the exact bug that `useMemo` on the other side prevents.
      return <SettingsScreen hideTitle />;
    case 'help':
      return <ContentViewer hideTitle />;
  }
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
