// SPDX-License-Identifier: GPL-3.0-or-later
import { contextBridge, ipcRenderer } from 'electron';
import {
  CHANNELS,
  EVENTS,
  type ClipboardView,
  type CredentialEdit,
  type CredentialInput,
  type FolderDeletePolicyName,
  type GeneratorLimitsView,
  type IpcResult,
  type OrganisationDeleteResult,
  type OrganisationSnapshot,
  type SettingsView,
  type KeyholdApi,
  type SessionStatusView,
} from '@shared/ipc/api.js';
import type {
  AttachmentAddView,
  AttachmentAudit,
  AttachmentPreview,
} from '@shared/model/attachment.js';
import { isMenuCommandId, type MenuCommandId } from '@shared/model/menu-commands.js';
import type { KdfProgressView } from '@shared/model/kdf-progress.js';
import type { VaultChangedExternally } from '@shared/model/vault-change.js';
import type { MergeReport } from '@shared/model/sync.js';
import type {
  ConflictCandidateView,
  MergeCommitResult,
  MergePreview,
  MergeResolveRequest,
} from '@shared/model/sync-plan.js';
import type {
  ThemeExportRequest,
  ThemeExportResponse,
  ThemeImportResponse,
} from '@shared/theme/theme-channels.js';
import type { ExportFormatDescriptor } from '@shared/model/export.js';
import type {
  ExportOutcome,
  ExportPlan,
  ExportPreview,
  ExportPreviewRequest,
} from '@shared/model/export-plan.js';
import type { ImportFormatDescriptor } from '@shared/model/import.js';
import type {
  ImportCommitRequest,
  ImportCommitResult,
  ImportPreview,
  ImportPreviewRequest,
  ImportProgress,
  ImportSource,
  ImportUndoRequest,
  ImportUndoResult,
} from '@shared/model/import-plan.js';
import type { CredentialProjection, SecretRef, VersionedField } from '@shared/model/credential.js';
import type { GeneratedPassword, GeneratorOptions } from '@shared/model/generator.js';
import type { HealthRuleId, HealthThresholds, VaultHealthReport } from '@shared/model/health.js';
import type { FieldDiffProjection, HistoryPointRef } from '@shared/model/history.js';
import type { PasswordStrength } from '@shared/model/strength.js';
import type { VaultLockedInfo, VaultSummary } from '@shared/model/vault-document.js';

/**
 * The preload bridge — the ONLY channel between the renderer and the main process.
 *
 * Rules for this file, which is the narrowest and most security-critical surface in the
 * app:
 *
 * 1. **Every exposed member is enumerated by hand.** `ipcRenderer` is never exposed, no
 *    exposed function takes a channel name from its caller, and nothing here is built
 *    dynamically. A single `invoke: (channel, ...args) => …` helper handed to the renderer
 *    would undo the entire allow-list — the renderer could then call any registered
 *    handler, including ones added later by someone who never considered this file.
 *
 * 2. **Nothing here holds state.** It forwards and returns; that is all. No caching of a
 *    revealed secret, no memoising a projection list.
 *
 * 3. **Secret material crosses only in response to an explicit, per-item request** —
 *    `credentials.revealSecret`, one `SecretRef` at a time, rate-limited and TTL-scoped by
 *    the broker on the other side. See decision D13.
 *
 * 4. **Events are subscribe-only, on a fixed channel.** `onStatusChanged` wraps one known
 *    event name; there is no general `on(channel, fn)`, which would be the receive-side
 *    equivalent of exposing `invoke`.
 */

/** Baked in at build time by electron-vite so the app can report its version. */
declare const APP_VERSION: string;

const api: KeyholdApi = {
  app: {
    getVersion: () => Promise.resolve(APP_VERSION),
    getPlatform: () => Promise.resolve(process.platform),

    /**
     * Native menu and tray commands, forwarded to the renderer.
     *
     * Two things this does deliberately.
     *
     * **It validates before forwarding.** `isMenuCommandId` refuses anything that is not in
     * the shared catalogue, so the renderer's listener can be typed rather than defensive.
     * The main process is trusted, but "the sender would never do that" is an assumption,
     * and the annotation on an IPC payload is gone by the time it arrives. Rule 4 of this
     * file, applied on the receive side.
     *
     * **It hides the event object.** The listener is handed the command and nothing else —
     * not `IpcRendererEvent`, which carries `sender` and `ports` and is a way for renderer
     * code to reach parts of Electron this bridge exists to keep away from it.
     */
    onMenuCommand: (listener: (command: MenuCommandId) => void) => {
      const forward = (_event: unknown, command: unknown): void => {
        if (isMenuCommandId(command)) listener(command);
      };
      ipcRenderer.on(EVENTS.menuCommand, forward);
      return () => {
        ipcRenderer.removeListener(EVENTS.menuCommand, forward);
      };
    },

    /**
     * The vault file changed on disk.
     *
     * Shape-checked before forwarding, like every other pushed payload: two numbers and two
     * booleans, and anything else is dropped. A malformed one is not worth throwing over —
     * the honest response to "we cannot read this notification" is to say nothing rather than
     * to tell the user their vault changed in a way we cannot describe.
     */
    onVaultChangedExternally: (listener: (change: VaultChangedExternally) => void) => {
      const forward = (_event: unknown, change: unknown): void => {
        if (typeof change !== 'object' || change === null) return;
        const raw = change as Record<string, unknown>;
        if (
          typeof raw.knownGeneration !== 'number' ||
          typeof raw.currentGeneration !== 'number' ||
          typeof raw.differentVault !== 'boolean' ||
          typeof raw.wentBackwards !== 'boolean'
        ) {
          return;
        }
        listener({
          knownGeneration: raw.knownGeneration,
          currentGeneration: raw.currentGeneration,
          differentVault: raw.differentVault,
          wentBackwards: raw.wentBackwards,
        });
      };
      ipcRenderer.on(EVENTS.vaultChangedExternally, forward);
      return () => {
        ipcRenderer.removeListener(EVENTS.vaultChangedExternally, forward);
      };
    },

    /**
     * The Argon2 progress estimate.
     *
     * Shape-checked like every other pushed payload, and the numbers are clamped rather than
     * merely validated: this feeds a width, and a fraction outside 0..1 arriving from anywhere
     * would draw a bar out of its track. Anything unreadable is dropped — the honest response
     * to "we cannot read this progress report" is to leave the bar where it was.
     */
    onKdfProgress: (listener: (progress: KdfProgressView) => void) => {
      const forward = (_event: unknown, progress: unknown): void => {
        if (typeof progress !== 'object' || progress === null) return;
        const raw = progress as Record<string, unknown>;
        if (
          typeof raw.fraction !== 'number' ||
          !Number.isFinite(raw.fraction) ||
          typeof raw.elapsedMs !== 'number' ||
          typeof raw.estimatedMs !== 'number' ||
          typeof raw.overdue !== 'boolean'
        ) {
          return;
        }
        listener({
          fraction: Math.min(1, Math.max(0, raw.fraction)),
          elapsedMs: Math.max(0, raw.elapsedMs),
          estimatedMs: Math.max(0, raw.estimatedMs),
          overdue: raw.overdue,
        });
      };
      ipcRenderer.on(EVENTS.kdfProgress, forward);
      return () => {
        ipcRenderer.removeListener(EVENTS.kdfProgress, forward);
      };
    },
  },

  session: {
    status: () =>
      ipcRenderer.invoke(CHANNELS.sessionStatus) as Promise<IpcResult<SessionStatusView>>,
    chooseVaultToOpen: () =>
      ipcRenderer.invoke(CHANNELS.sessionChooseVaultToOpen) as Promise<IpcResult<string | null>>,
    chooseVaultLocation: (suggestedName?: string) =>
      ipcRenderer.invoke(CHANNELS.sessionChooseVaultLocation, suggestedName) as Promise<
        IpcResult<string | null>
      >,
    estimateStrength: (password: string) =>
      ipcRenderer.invoke(CHANNELS.sessionEstimateStrength, password) as Promise<
        IpcResult<PasswordStrength>
      >,
    copySecret: (ref: SecretRef) =>
      ipcRenderer.invoke(CHANNELS.sessionCopySecret, ref) as Promise<
        IpcResult<ClipboardView | null>
      >,
    clearClipboard: () =>
      ipcRenderer.invoke(CHANNELS.sessionClearClipboard) as Promise<IpcResult<ClipboardView>>,
    enrolQuickUnlock: () =>
      ipcRenderer.invoke(CHANNELS.sessionEnrolQuickUnlock) as Promise<IpcResult<null>>,
    revokeQuickUnlock: () =>
      ipcRenderer.invoke(CHANNELS.sessionRevokeQuickUnlock) as Promise<IpcResult<null>>,
    unlockWithQuickUnlock: (path: string) =>
      ipcRenderer.invoke(CHANNELS.sessionUnlockWithQuickUnlock, path) as Promise<
        IpcResult<VaultSummary | null>
      >,
    forgetVault: (path: string) =>
      ipcRenderer.invoke(CHANNELS.sessionForgetVault, path) as Promise<IpcResult<null>>,

    onStatusChanged: (listener: () => void) => {
      // The listener receives no payload on purpose: the renderer re-reads status through
      // the normal channel, so there is exactly one shape of truth and no chance of an
      // event carrying something the status endpoint would have filtered out.
      const handler = (): void => {
        listener();
      };
      ipcRenderer.on(EVENTS.sessionChanged, handler);
      return () => {
        ipcRenderer.off(EVENTS.sessionChanged, handler);
      };
    },
  },

  vault: {
    inspect: (path: string) =>
      ipcRenderer.invoke(CHANNELS.vaultInspect, path) as Promise<IpcResult<VaultLockedInfo>>,
    create: (path: string, password: string) =>
      ipcRenderer.invoke(CHANNELS.vaultCreate, path, password) as Promise<IpcResult<VaultSummary>>,
    unlock: (path: string, password: string) =>
      ipcRenderer.invoke(CHANNELS.vaultUnlock, path, password) as Promise<IpcResult<VaultSummary>>,
    lock: () => ipcRenderer.invoke(CHANNELS.vaultLock) as Promise<IpcResult<null>>,
    save: () => ipcRenderer.invoke(CHANNELS.vaultSave) as Promise<IpcResult<VaultSummary>>,
    summary: () =>
      ipcRenderer.invoke(CHANNELS.vaultSummary) as Promise<IpcResult<VaultSummary | null>>,
    hasUnsavedChanges: () =>
      ipcRenderer.invoke(CHANNELS.vaultHasUnsavedChanges) as Promise<IpcResult<boolean>>,
    /**
     * Re-reads the open vault from disk after another device wrote it.
     *
     * No path and no password: the file is the one already open, and the key is already
     * held. Refused by the main process when there are unsaved changes or when a different
     * vault is at the path — both come back as failures with a code rather than as a
     * surprise, because both mean something the user has to be told.
     */
    reload: () => ipcRenderer.invoke(CHANNELS.vaultReload) as Promise<IpcResult<VaultSummary>>,
  },

  credentials: {
    list: (options?: { includeTrashed?: boolean }) =>
      ipcRenderer.invoke(CHANNELS.credentialsList, options) as Promise<
        IpcResult<CredentialProjection[]>
      >,
    get: (credentialId: string) =>
      ipcRenderer.invoke(CHANNELS.credentialsGet, credentialId) as Promise<
        IpcResult<CredentialProjection | null>
      >,
    revealSecret: (ref: SecretRef) =>
      ipcRenderer.invoke(CHANNELS.credentialsRevealSecret, ref) as Promise<
        IpcResult<string | null>
      >,
    deepSearch: (query: string) =>
      ipcRenderer.invoke(CHANNELS.credentialsDeepSearch, query) as Promise<IpcResult<string[]>>,

    create: (input: CredentialInput) =>
      ipcRenderer.invoke(CHANNELS.credentialsCreate, input) as Promise<
        IpcResult<CredentialProjection>
      >,
    update: (credentialId: string, edit: CredentialEdit) =>
      ipcRenderer.invoke(CHANNELS.credentialsUpdate, credentialId, edit) as Promise<
        IpcResult<{ projection: CredentialProjection; changedFields: string[] } | null>
      >,
    duplicate: (credentialId: string) =>
      ipcRenderer.invoke(CHANNELS.credentialsDuplicate, credentialId) as Promise<
        IpcResult<CredentialProjection | null>
      >,
    trash: (credentialId: string) =>
      ipcRenderer.invoke(CHANNELS.credentialsTrash, credentialId) as Promise<IpcResult<boolean>>,
    restore: (credentialId: string) =>
      ipcRenderer.invoke(CHANNELS.credentialsRestore, credentialId) as Promise<IpcResult<boolean>>,
    purge: (credentialId: string) =>
      ipcRenderer.invoke(CHANNELS.credentialsPurge, credentialId) as Promise<IpcResult<boolean>>,
    markUsed: (credentialId: string) =>
      ipcRenderer.invoke(CHANNELS.credentialsMarkUsed, credentialId) as Promise<IpcResult<null>>,
  },

  generator: {
    generate: (options: GeneratorOptions) =>
      ipcRenderer.invoke(CHANNELS.generatorGenerate, options) as Promise<
        IpcResult<GeneratedPassword>
      >,
    estimate: (options: GeneratorOptions) =>
      ipcRenderer.invoke(CHANNELS.generatorEstimate, options) as Promise<IpcResult<number>>,
    limits: () =>
      ipcRenderer.invoke(CHANNELS.generatorLimits) as Promise<IpcResult<GeneratorLimitsView>>,
  },

  health: {
    analyse: (options?: {
      enabledRules?: Partial<Record<HealthRuleId, boolean>>;
      thresholds?: Partial<HealthThresholds>;
    }) =>
      ipcRenderer.invoke(CHANNELS.healthAnalyse, options) as Promise<IpcResult<VaultHealthReport>>,
  },

  history: {
    diff: (credentialId: string, versionNumber: number) =>
      ipcRenderer.invoke(CHANNELS.historyDiff, credentialId, versionNumber) as Promise<
        IpcResult<FieldDiffProjection[] | null>
      >,
    compare: (credentialId: string, from: HistoryPointRef, to: HistoryPointRef) =>
      ipcRenderer.invoke(CHANNELS.historyCompare, credentialId, from, to) as Promise<
        IpcResult<FieldDiffProjection[] | null>
      >,
    restoreVersion: (credentialId: string, versionNumber: number) =>
      ipcRenderer.invoke(CHANNELS.historyRestoreVersion, credentialId, versionNumber) as Promise<
        IpcResult<{ projection: CredentialProjection; changedFields: string[] } | null>
      >,
    restoreField: (credentialId: string, versionNumber: number, field: VersionedField) =>
      ipcRenderer.invoke(
        CHANNELS.historyRestoreField,
        credentialId,
        versionNumber,
        field
      ) as Promise<IpcResult<{ projection: CredentialProjection; changedFields: string[] } | null>>,
    /** The audit trail for one record. No path in either direction; see decision D27. */
    exportHistory: (credentialId: string) =>
      ipcRenderer.invoke(CHANNELS.historyExport, credentialId) as Promise<IpcResult<string | null>>,
    clear: (credentialId: string) =>
      ipcRenderer.invoke(CHANNELS.historyClear, credentialId) as Promise<IpcResult<boolean>>,
    networkName: () =>
      ipcRenderer.invoke(CHANNELS.historyNetworkName) as Promise<IpcResult<string | null>>,
  },

  organisation: {
    list: () =>
      ipcRenderer.invoke(CHANNELS.organisationList) as Promise<IpcResult<OrganisationSnapshot>>,

    createFolder: (name: string, parentId: string | null) =>
      ipcRenderer.invoke(CHANNELS.foldersCreate, name, parentId) as Promise<
        IpcResult<OrganisationSnapshot>
      >,
    renameFolder: (folderId: string, name: string) =>
      ipcRenderer.invoke(CHANNELS.foldersRename, folderId, name) as Promise<
        IpcResult<OrganisationSnapshot>
      >,
    moveFolder: (folderId: string, parentId: string | null, index?: number) =>
      ipcRenderer.invoke(CHANNELS.foldersMove, folderId, parentId, index) as Promise<
        IpcResult<OrganisationSnapshot>
      >,
    deleteFolder: (folderId: string, policy: FolderDeletePolicyName) =>
      ipcRenderer.invoke(CHANNELS.foldersDelete, folderId, policy) as Promise<
        IpcResult<OrganisationDeleteResult>
      >,

    createTag: (name: string, colour: string) =>
      ipcRenderer.invoke(CHANNELS.tagsCreate, name, colour) as Promise<
        IpcResult<OrganisationSnapshot>
      >,
    renameTag: (tagId: string, name: string) =>
      ipcRenderer.invoke(CHANNELS.tagsRename, tagId, name) as Promise<
        IpcResult<OrganisationDeleteResult>
      >,
    setTagColour: (tagId: string, colour: string) =>
      ipcRenderer.invoke(CHANNELS.tagsSetColour, tagId, colour) as Promise<
        IpcResult<OrganisationSnapshot>
      >,
    deleteTag: (tagId: string) =>
      ipcRenderer.invoke(CHANNELS.tagsDelete, tagId) as Promise<
        IpcResult<OrganisationDeleteResult>
      >,
  },

  settings: {
    read: () => ipcRenderer.invoke(CHANNELS.settingsRead) as Promise<IpcResult<SettingsView>>,
    updateMachine: (patch: Record<string, unknown>) =>
      ipcRenderer.invoke(CHANNELS.settingsUpdateMachine, patch) as Promise<IpcResult<SettingsView>>,
    updateVault: (patch: Record<string, unknown>) =>
      ipcRenderer.invoke(CHANNELS.settingsUpdateVault, patch) as Promise<IpcResult<SettingsView>>,
    clearAllHistory: () =>
      ipcRenderer.invoke(CHANNELS.settingsClearAllHistory) as Promise<IpcResult<number>>,
  },

  attachments: {
    add: (credentialId: string) =>
      ipcRenderer.invoke(CHANNELS.attachmentsAdd, credentialId) as Promise<
        IpcResult<AttachmentAddView | null>
      >,
    remove: (credentialId: string, attachmentId: string) =>
      ipcRenderer.invoke(CHANNELS.attachmentsRemove, credentialId, attachmentId) as Promise<
        IpcResult<boolean>
      >,
    save: (credentialId: string, attachmentId: string) =>
      ipcRenderer.invoke(CHANNELS.attachmentsSave, credentialId, attachmentId) as Promise<
        IpcResult<string | null>
      >,
    audit: () =>
      ipcRenderer.invoke(CHANNELS.attachmentsAudit) as Promise<IpcResult<AttachmentAudit>>,
    // The one attachment call that returns content. It travels as a `Uint8Array`, which
    // structured clone moves without a base64 round trip — a 20 MB scan encoded as text
    // would be three copies of somebody's passport in memory instead of one.
    preview: (credentialId: string, attachmentId: string) =>
      ipcRenderer.invoke(CHANNELS.attachmentsPreview, credentialId, attachmentId) as Promise<
        IpcResult<AttachmentPreview | null>
      >,
  },

  exporter: {
    formats: () =>
      ipcRenderer.invoke(CHANNELS.exportFormats) as Promise<
        IpcResult<readonly ExportFormatDescriptor[]>
      >,
    preview: (request: ExportPreviewRequest) =>
      ipcRenderer.invoke(CHANNELS.exportPreview, request) as Promise<IpcResult<ExportPreview>>,
    // The plan carries a passphrase for a parcel and the typed confirmation for a plaintext
    // dump. Both travel renderer -> main only, which is the direction secrets are allowed to
    // go: the user typed them. Nothing comes back but a location.
    run: (plan: ExportPlan) =>
      ipcRenderer.invoke(CHANNELS.exportRun, plan) as Promise<IpcResult<ExportOutcome>>,
  },

  importer: {
    formats: () =>
      ipcRenderer.invoke(CHANNELS.importerFormats) as Promise<
        IpcResult<readonly ImportFormatDescriptor[]>
      >,
    // No argument, and no path in the result. The dialog opens on the other side.
    chooseFile: () =>
      ipcRenderer.invoke(CHANNELS.importerChooseFile) as Promise<IpcResult<ImportSource | null>>,
    preview: (request: ImportPreviewRequest) =>
      ipcRenderer.invoke(CHANNELS.importerPreview, request) as Promise<IpcResult<ImportPreview>>,
    commit: (request: ImportCommitRequest) =>
      ipcRenderer.invoke(CHANNELS.importerCommit, request) as Promise<
        IpcResult<ImportCommitResult>
      >,
    undo: (request: ImportUndoRequest) =>
      ipcRenderer.invoke(CHANNELS.importerUndo, request) as Promise<IpcResult<ImportUndoResult>>,
    discard: (sourceId: string) =>
      ipcRenderer.invoke(CHANNELS.importerDiscard, sourceId) as Promise<IpcResult<null>>,

    /**
     * Commit progress, pushed from the main process.
     *
     * This was missing, and nothing noticed because `ImporterApi` had been written out twice
     * and only one copy declared it — so the wizard's progress bar was subscribing to a
     * method that did not exist on the object it was handed. Folding the two declarations
     * into one turned that into a compile error.
     *
     * Same shape as `onMenuCommand` and `onStatusChanged`: a fixed channel, an unsubscribe
     * returned, and the `IpcRendererEvent` hidden — the renderer is handed the payload and
     * nothing that would let it reach the rest of Electron.
     */
    onProgress: (listener: (progress: ImportProgress) => void) => {
      const forward = (_event: unknown, progress: unknown): void => {
        // Shape-checked before forwarding, like every other pushed payload. A progress event
        // is cosmetic, so a malformed one is dropped rather than thrown: failing an import
        // because its progress bar got a bad number would be the tail wagging the dog.
        if (typeof progress === 'object' && progress !== null) {
          listener(progress as ImportProgress);
        }
      };
      ipcRenderer.on(EVENTS.importProgress, forward);
      return () => {
        ipcRenderer.removeListener(EVENTS.importProgress, forward);
      };
    },
  },

  sync: {
    /**
     * Merging another copy of this vault.
     *
     * No path in either direction. `prepare` opens the file dialog on the other side, reads
     * the other copy, takes the mandatory pre-merge backup and merges once — the renderer
     * learns a plan id, a report, and the name of the backup file. `null` means the dialog
     * was dismissed.
     *
     * The report carries lengths where a secret would be, so none of these calls can be made
     * to hand over a credential. Resolving sends a side by name and the merge re-runs in the
     * main process, which is what makes that true rather than merely intended.
     */
    candidates: () =>
      ipcRenderer.invoke(CHANNELS.syncCandidates) as Promise<
        IpcResult<readonly ConflictCandidateView[]>
      >,
    prepare: (candidateId?: string) =>
      ipcRenderer.invoke(CHANNELS.syncPrepare, candidateId) as Promise<
        IpcResult<MergePreview | null>
      >,
    resolve: (request: MergeResolveRequest) =>
      ipcRenderer.invoke(CHANNELS.syncResolve, request) as Promise<IpcResult<MergeReport>>,
    commit: (planId: string) =>
      ipcRenderer.invoke(CHANNELS.syncCommit, planId) as Promise<IpcResult<MergeCommitResult>>,
    // Not politeness: what is dropped is a decrypted copy of another whole vault.
    discard: (planId: string) =>
      ipcRenderer.invoke(CHANNELS.syncDiscard, planId) as Promise<IpcResult<null>>,
  },

  theme: {
    // No argument and no path in the result: the dialog opens on the other side, and the
    // file is parsed there too. What comes back is a projection, never the file's own text.
    importTheme: () =>
      ipcRenderer.invoke(CHANNELS.themeImport) as Promise<IpcResult<ThemeImportResponse>>,
    // A theme object, not a blob of text. The main process re-validates and re-serialises it,
    // so the bytes in the file the user names are ones Keyhold wrote.
    exportTheme: (request: ThemeExportRequest) =>
      ipcRenderer.invoke(CHANNELS.themeExport, request) as Promise<IpcResult<ThemeExportResponse>>,
    takeOpenedTheme: () =>
      ipcRenderer.invoke(CHANNELS.themeTakeOpened) as Promise<
        IpcResult<ThemeImportResponse | null>
      >,
    /**
     * The OS handed the app a `.keeptheme`.
     *
     * Same shape as `onMenuCommand` and `onStatusChanged`: one fixed channel, an unsubscribe
     * returned, and the `IpcRendererEvent` hidden. The event carries no payload at all, so
     * there is nothing to shape-check and nothing a later edit could widen into a path — the
     * listener's only job is to call `takeOpenedTheme`.
     */
    onFileOpened: (listener: () => void) => {
      const forward = (): void => {
        listener();
      };
      ipcRenderer.on(EVENTS.themeFileOpened, forward);
      return () => {
        ipcRenderer.removeListener(EVENTS.themeFileOpened, forward);
      };
    },
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('keyhold', api);
} else {
  // `contextIsolation` is forced on in HARDENED_WEB_PREFERENCES, so reaching here means
  // someone weakened the window config. Fail loudly rather than silently degrading to an
  // insecure bridge that puts this API directly on `window` for any page script to reach.
  throw new Error(
    'Keyhold requires contextIsolation. Refusing to expose the API without it — see src/main/security.ts.'
  );
}
