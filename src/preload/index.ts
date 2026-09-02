// SPDX-License-Identifier: GPL-3.0-or-later
import { contextBridge } from 'electron';
import type { KeyholdApi } from '@shared/ipc/api.js';

/**
 * The preload bridge — the ONLY channel between the renderer and the main process.
 *
 * Rules for this file, which is the narrowest and most security-critical surface
 * in the app:
 *
 *   1. Every exposed member is enumerated by hand. Never expose `ipcRenderer`,
 *      never expose a function that takes a channel name from the caller, and
 *      never expose anything constructed dynamically.
 *   2. Nothing here holds state. It forwards and returns; that is all.
 *   3. Secret material crosses here only in response to an explicit, per-item
 *      request from the user (a reveal or a copy), and the main process expires
 *      it on a timer. See decision D13.
 *
 * The API surface itself is defined in @shared/ipc so the renderer's types and the
 * main process's handlers come from one source rather than two that drift.
 */

const api: KeyholdApi = {
  app: {
    getVersion: () => Promise.resolve(APP_VERSION),
    getPlatform: () => Promise.resolve(process.platform),
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('keyhold', api);
} else {
  // contextIsolation is forced on in HARDENED_WEB_PREFERENCES, so reaching here
  // means someone weakened the window config. Fail loudly rather than silently
  // degrading to an insecure bridge.
  throw new Error(
    'Keyhold requires contextIsolation. Refusing to expose the API without it — see src/main/security.ts.'
  );
}

/** Injected at build time by electron-vite from package.json. */
declare const APP_VERSION: string;
