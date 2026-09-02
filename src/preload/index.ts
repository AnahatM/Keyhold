// SPDX-License-Identifier: GPL-3.0-or-later
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type IpcResult, type KeyholdApi } from '@shared/ipc/api.js';
import type { CredentialProjection, SecretRef } from '@shared/model/credential.js';
import type { VaultLockedInfo, VaultSummary } from '@shared/model/vault-document.js';

/**
 * The preload bridge — the ONLY channel between the renderer and the main process.
 *
 * Rules for this file, which is the narrowest and most security-critical surface in the
 * app:
 *
 * 1. **Every exposed member is enumerated by hand.** `ipcRenderer` is never exposed, no
 *    exposed function takes a channel name from its caller, and nothing here is built
 *    dynamically. A single `invoke: (channel, ...args) => ...` helper handed to the
 *    renderer would undo the entire allow-list — the renderer could then call any
 *    registered handler, including ones added later by someone who never considered this.
 *
 * 2. **Nothing here holds state.** It forwards and returns; that is all. No caching of a
 *    revealed secret, no memoising a projection list.
 *
 * 3. **Secret material crosses only in response to an explicit, per-item request** —
 *    `credentials.revealSecret`, one `SecretRef` at a time, rate-limited and TTL-scoped
 *    by the broker on the other side. See decision D13.
 *
 * The API shape lives in `@shared/ipc/api.ts` so the renderer's types and the main
 * process's handlers come from one source rather than two that drift.
 */

/** Baked in at build time by electron-vite so the app can report its version. */
declare const APP_VERSION: string;

const api: KeyholdApi = {
  app: {
    getVersion: () => Promise.resolve(APP_VERSION),
    getPlatform: () => Promise.resolve(process.platform),
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
