// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../vault/session-store.js';
import { useCredentials } from '../vault/credential-store.js';
import { Button } from '../components/Button.js';
import { folderDeletionImpact, countRecordsByFolder } from './folder-counts.js';
import { DeleteFolderDialog } from './DeleteFolderDialog.js';
import { FolderTree } from './FolderTree.js';
import type { FolderDeletionPolicy } from './gateway.js';
import { MoveToDialog } from './MoveToDialog.js';
import { credentialMoveTargets, folderMoveTargets } from './move-targets.js';
import { useOrganisation } from './organisation-store.js';
import { SavedSearchList } from './SavedSearchList.js';
import { useSavedSearches } from './saved-search-store.js';
import { useSiteRules } from './site-rule-store.js';
import { SmartViewList } from './SmartViewList.js';
import { TagFilterList } from './TagFilterList.js';
import './organisation.css';

/**
 * The organisation sidebar — smart views, the folder tree, and the tag filters.
 *
 * Mounted in place of the placeholder nav in `VaultScreen.tsx` (see the handover report for
 * the exact edit). It owns no filtering of its own: it produces a `SidebarSelection`, and
 * `visibleForSelection` in `selection.ts` turns that into a list through the shared search
 * engine.
 *
 * ## What it does when the vault cannot answer
 *
 * The folder and tag IPC is being written in parallel and may not exist in this build. The
 * gateway degrades to an empty snapshot rather than throwing, so the smart views — which run
 * entirely off projections the renderer already holds — work regardless, and only the
 * mutating controls report that they cannot act yet. A sidebar that throws because one of
 * its three sections has no backend is a worse outcome than one that is partly useful.
 */

export function OrganisationSidebar(): React.JSX.Element {
  const { status, credentials, refresh } = useSession();
  const selectedCredentialId = useCredentials((state) => state.selectedId);

  const {
    tree,
    tags,
    selection,
    expanded,
    focusedFolderId,
    renamingFolderId,
    renamingTagId,
    draftParentId,
    busy,
    error,
    attachVault,
    clearError,
    selectView,
    toggleTagFilter,
    setTagMatch,
    setIncludeDescendantFolders,
    setExpanded,
    toggleExpanded,
    focusFolder,
    beginCreate,
    beginRename,
    beginTagRename,
    cancelEditing,
    createFolder,
    renameFolder,
    moveFolder,
    deleteFolder,
    fileCredential,
    renameTag,
  } = useOrganisation();

  const refreshSearches = useSavedSearches((state) => state.refresh);
  const refreshSiteRules = useSiteRules((state) => state.refresh);

  const [movingFolderId, setMovingFolderId] = useState<string | null>(null);
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const [movingCredentialId, setMovingCredentialId] = useState<string | null>(null);

  const vaultId = status?.vault?.vaultId ?? '';

  // Reattaching on a vault change reloads the folder list and the expansion set that belongs
  // to *that* vault. Nothing is set synchronously here — `attachVault` is async and the
  // effect only kicks it off.
  useEffect(() => {
    if (vaultId === '') return;
    void attachVault(vaultId);
  }, [vaultId, attachVault]);

  // Keyed on the vault too, and for a sharper reason than the folders above: saved searches
  // live inside the encrypted body, so the list belongs to one vault and showing another
  // vault's shortcuts would be showing the names somebody gave to queries about records that
  // are not open.
  useEffect(() => {
    if (vaultId === '') return;
    void refreshSearches();
  }, [vaultId, refreshSearches]);

  // Loaded here rather than in the editor, because the editor mounts and unmounts constantly
  // and re-reading the rule list on every record selection would be a channel call per click
  // for a list that changes only when the user changes one.
  useEffect(() => {
    if (vaultId === '') return;
    void refreshSiteRules();
  }, [vaultId, refreshSiteRules]);

  const counts = useMemo(() => countRecordsByFolder(credentials, tree), [credentials, tree]);

  const selectedFolderId = selection.view.kind === 'folder' ? selection.view.folderId : null;
  const selectedViewId = selection.view.kind === 'smart' ? selection.view.viewId : null;
  const selectedSearchId = selection.view.kind === 'saved-search' ? selection.view.searchId : null;

  const movingFolderName =
    movingFolderId === null ? '' : (tree.byId.get(movingFolderId)?.folder.name ?? '');
  const deletingFolderName =
    deletingFolderId === null ? '' : (tree.byId.get(deletingFolderId)?.folder.name ?? '');
  const movingCredential =
    movingCredentialId === null
      ? null
      : (credentials.find((record) => record.id === movingCredentialId) ?? null);
  const selectedCredential =
    selectedCredentialId === null
      ? null
      : (credentials.find((record) => record.id === selectedCredentialId) ?? null);

  /**
   * Filing a record changes the record, not the folder list, so the *session* has to
   * re-read. Without this the row would keep its old folder until something else refreshed.
   */
  const fileAndRefresh = (credentialId: string, folderId: string | null): void => {
    void fileCredential(credentialId, folderId).then((ok) => {
      if (ok) return refresh();
      return undefined;
    });
  };

  return (
    <div className="kh-organisation">
      <SmartViewList
        records={credentials}
        selectedViewId={selectedViewId}
        onSelect={(viewId) => {
          selectView({ kind: 'smart', viewId });
        }}
      />

      <SavedSearchList
        records={credentials}
        selectedSearchId={selectedSearchId}
        onSelect={(search) => {
          selectView({
            kind: 'saved-search',
            searchId: search.id,
            name: search.name,
            query: search.query,
          });
        }}
      />

      <FolderTree
        tree={tree}
        records={credentials}
        expanded={expanded}
        selectedFolderId={selectedFolderId}
        focusedFolderId={focusedFolderId}
        renamingFolderId={renamingFolderId}
        draftParentId={draftParentId}
        busy={busy}
        onSelectFolder={(folderId) => {
          selectView({ kind: 'folder', folderId });
          focusFolder(folderId);
        }}
        onSetExpanded={setExpanded}
        onToggleExpanded={toggleExpanded}
        onFocusFolder={focusFolder}
        onBeginCreate={beginCreate}
        onBeginRename={beginRename}
        onCancelEditing={cancelEditing}
        onCreateFolder={(name, parentId) => {
          void createFolder(name, parentId);
        }}
        onRenameFolder={(folderId, name) => {
          void renameFolder(folderId, name);
        }}
        onMoveFolder={(folderId, parentId) => {
          void moveFolder(folderId, parentId);
        }}
        onRequestMove={setMovingFolderId}
        onRequestDelete={setDeletingFolderId}
        onFileCredential={fileAndRefresh}
      />

      {selectedFolderId !== null && (
        <label className="kh-organisation__toggle">
          <input
            type="checkbox"
            checked={selection.includeDescendantFolders}
            onChange={(event) => {
              setIncludeDescendantFolders(event.target.checked);
            }}
          />
          <span>Include subfolders</span>
        </label>
      )}

      {/*
       * The keyboard path for "drag this record onto a folder". It lives here rather than
       * only on the record's detail pane so that the sidebar is self-sufficient: the drag
       * and its alternative are in the same place, which is the point of SC 2.5.7.
       */}
      {selectedCredential !== null && (
        <div className="kh-organisation__record-move">
          <span className="kh-organisation__record-title">
            {selectedCredential.title === '' ? 'Untitled' : selectedCredential.title}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setMovingCredentialId(selectedCredential.id);
            }}
          >
            File in folder…
          </Button>
        </div>
      )}

      <TagFilterList
        tags={tags}
        records={credentials}
        selectedTagIds={selection.tagIds}
        tagMatch={selection.tagMatch}
        busy={busy}
        renamingTagId={renamingTagId}
        onToggleTag={toggleTagFilter}
        onTagMatchChange={setTagMatch}
        onClearTags={() => {
          for (const tagId of selection.tagIds) toggleTagFilter(tagId);
        }}
        onBeginRename={beginTagRename}
        onRenameTag={(tagId, name) => {
          void renameTag(tagId, name);
        }}
      />

      {error !== null && (
        // `role="alert"` so a refused rename or a missing bridge is announced when it
        // happens, rather than sitting silently under a control the user already left.
        <p className="kh-organisation__error" role="alert">
          {error}
          <Button variant="ghost" size="sm" iconOnlyLabel="Dismiss" onClick={clearError}>
            ✕
          </Button>
        </p>
      )}

      {movingFolderId !== null && (
        <MoveToDialog
          key={`folder:${movingFolderId}`}
          open
          subject={movingFolderName}
          targets={folderMoveTargets(tree.folders, tree, movingFolderId)}
          busy={busy}
          onMove={(parentId) => {
            void moveFolder(movingFolderId, parentId).then(() => {
              setMovingFolderId(null);
            });
          }}
          onCancel={() => {
            setMovingFolderId(null);
          }}
        />
      )}

      {movingCredential !== null && (
        <MoveToDialog
          key={`credential:${movingCredential.id}`}
          open
          subject={movingCredential.title === '' ? 'Untitled' : movingCredential.title}
          targets={credentialMoveTargets(tree, movingCredential.folderId)}
          busy={busy}
          onMove={(folderId) => {
            fileAndRefresh(movingCredential.id, folderId);
            setMovingCredentialId(null);
          }}
          onCancel={() => {
            setMovingCredentialId(null);
          }}
        />
      )}

      {deletingFolderId !== null && (
        <DeleteFolderDialog
          key={`delete:${deletingFolderId}`}
          open
          folderName={deletingFolderName}
          impact={folderDeletionImpact(tree, counts, deletingFolderId)}
          busy={busy}
          onConfirm={(policy: FolderDeletionPolicy) => {
            void deleteFolder(deletingFolderId, policy).then((ok) => {
              setDeletingFolderId(null);
              // The records moved, so the session's projections are stale.
              if (ok) return refresh();
              return undefined;
            });
          }}
          onCancel={() => {
            setDeletingFolderId(null);
          }}
        />
      )}
    </div>
  );
}
