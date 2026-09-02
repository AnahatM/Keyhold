// SPDX-License-Identifier: GPL-3.0-or-later
import { contextBridge, ipcRenderer } from 'electron';
import {
  CHANNELS,
  EVENTS,
  type ClipboardView,
  type CredentialEdit,
  type CredentialInput,
  type IpcResult,
  type KeyholdApi,
  type SessionStatusView,
} from '@shared/ipc/api.js';
import type { CredentialProjection, SecretRef } from '@shared/model/credential.js';
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
